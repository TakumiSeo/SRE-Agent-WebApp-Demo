# SRE Agent WebApp Demo – Demo A (/healthz & /burst)

このリポは Node.js 実装です。Demo A で **Cosmos DB の 429** と **ホットパーティション** を再現するための最小メモをここに集約します。

## 0) 前提（Cosmos 側）

- Cosmos を以下で作成している前提
  - Database id: `appdb`
  - Container id: `items`
  - Partition key: `/pk`
  - Throughput: Manual 400 RU/s
- もし pk パスが違う場合は、Node/.NET どちらも **pk 用プロパティ名（例: `pk`）** をあなたの pk パスに合わせて置き換えてください

## 1) エンドポイント仕様（Demo A で使う前提）

- `GET /healthz`
  - Cosmos を **1 回だけ**叩く軽い経路（疎通確認用）
- `GET /burst?mode=hot|spread&items=N&pk=...`
  - 1 HTTP リクエスト内で `items` 回、**upsert + read** を連続実行して重くする経路
  - 429 を見えやすくするため、Cosmos SDK の 429 自動リトライは **OFF** にする（Node: `retryOptions.maxRetryAttemptsOnThrottledRequests = 0` / .NET: `MaxRetryAttemptsOnRateLimitedRequests = 0`）

## 2) Node.js 実装（このリポの貼り付け先）

### 2.1 貼り付け先

- ルーティング: `app.js`
  - `GET /healthz`
  - `GET /burst`
- Cosmos 操作: `cosmos.js`
  - `getContainer()`（クライアント生成 & リトライ無効化）
  - `runBurst({ mode, items, pk })`

### 2.2 最小コード（参考）

このリポには既に実装済みです。差し替えたい場合の最小形は以下です。

- `app.js`: `/healthz` と `/burst` のルートを追加し、`runBurst()` を呼ぶ
- `cosmos.js`: `runBurst()` で `items` 回、`upsert`→`read` を繰り返す

※ `/burst` のパラメータ

- `mode=hot`
  - pk を固定（ホットパーティション狙い）
- `mode=spread`
  - pk を毎回変える（全体RU不足 / 多パーティションにばらす狙い）

## 3) .NET 実装（貼り付け用の最小例）

このリポに .NET プロジェクトは無いので、貼り付け用の最小例だけ載せます（ASP.NET Core Minimal API）。

### 3.1 依存パッケージ

- `Microsoft.Azure.Cosmos`

### 3.2 Program.cs（最小例）

```csharp
using Microsoft.Azure.Cosmos;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

string endpoint = Environment.GetEnvironmentVariable("COSMOS_ENDPOINT") ?? throw new Exception("COSMOS_ENDPOINT missing");
string? key = Environment.GetEnvironmentVariable("COSMOS_KEY");
string? connectionString = Environment.GetEnvironmentVariable("COSMOS_CONNECTION_STRING");

string databaseId = Environment.GetEnvironmentVariable("COSMOS_DATABASE_ID") ?? "appdb";
string containerId = Environment.GetEnvironmentVariable("COSMOS_CONTAINER_ID") ?? "items";

var clientOptions = new CosmosClientOptions
{
    // Demo-first: surface 429s instead of retrying.
    MaxRetryAttemptsOnRateLimitedRequests = 0,
    MaxRetryWaitTimeOnRateLimitedRequests = TimeSpan.Zero,
};

CosmosClient client = connectionString is { Length: > 0 }
    ? new CosmosClient(connectionString, clientOptions)
    : new CosmosClient(endpoint, key, clientOptions);

Container container = client.GetContainer(databaseId, containerId);

app.MapGet("/healthz", async () =>
{
    var resp = await container.ReadContainerAsync();
    return Results.Json(new
    {
        ok = true,
        endpoint,
        databaseId,
        containerId,
        statusCode = (int)resp.StatusCode,
        requestCharge = resp.RequestCharge,
    });
});

app.MapGet("/burst", async (HttpRequest req) =>
{
    string mode = (req.Query["mode"].ToString() ?? "hot").ToLowerInvariant();
    int items = int.TryParse(req.Query["items"], out var n) ? Math.Clamp(n, 1, 1000) : 25;
    string pkBase = string.IsNullOrWhiteSpace(req.Query["pk"]) ? "hot-1" : req.Query["pk"].ToString();

    var startedAt = DateTimeOffset.UtcNow;
    int ok = 0, throttled429 = 0, otherErrors = 0;
    double totalRu = 0;
    int? lastRetryAfterMs = null;

    for (int i = 0; i < items; i++)
    {
        string pk = mode == "spread" ? $"{pkBase}-{i}-{Guid.NewGuid():N}" : pkBase;
        string id = Guid.NewGuid().ToString();

        // NOTE: pk パスが /pk 前提
        var doc = new
        {
          id,
          pk,
          category = pk,
          name = $"burst-{i}",
          quantity = i,
          price = i,
          clearance = false,
          ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };

        try
        {
            var upsert = await container.UpsertItemAsync(doc, new PartitionKey(pk));
            totalRu += upsert.RequestCharge;

            var read = await container.ReadItemAsync<dynamic>(id, new PartitionKey(pk));
            totalRu += read.RequestCharge;

            ok++;
        }
        catch (CosmosException ex) when ((int)ex.StatusCode == 429)
        {
            throttled429++;
            lastRetryAfterMs = (int?)ex.RetryAfter?.TotalMilliseconds;
        }
        catch
        {
            otherErrors++;
        }
    }

    var elapsedMs = (int)(DateTimeOffset.UtcNow - startedAt).TotalMilliseconds;

    int status = throttled429 > 0 ? 429 : 200;
    return Results.Json(new
    {
        ok = true,
        mode,
        itemsRequested = items,
        pk = pkBase,
        okCount = ok,
        throttled429,
        otherErrors,
        totalRequestCharge = totalRu,
        lastRetryAfterMs,
        elapsedMs,
    }, statusCode: status);
});

app.Run();
```

## 4) 再現用の呼び出し例（hot/spread）

- ホットパーティション狙い（pk 固定）
  - `GET /burst?mode=hot&pk=hot-1&items=25`
- 全体RU不足狙い（pk を分散）
  - `GET /burst?mode=spread&pk=base&items=25`

目安:

- まず `items=25` から。
- 429 が出ない場合は `items` を上げる（例: 100, 300）。
- RU を絞った小さいコンテナだと少ない `items` でも出やすいです。

## 5) 環境変数（App settings を推奨）

このデモは「App settings（環境変数）で明示的に渡す」のが最短です。

- `COSMOS_ENDPOINT`
- `COSMOS_KEY`（Key 認証を使う場合）
- `COSMOS_DATABASE_ID`
- `COSMOS_CONTAINER_ID`

接続文字列で渡したい場合:

- `COSMOS_CONNECTION_STRING` に入れるのが分かりやすい（App Service の “Connection strings” 機能を使う場合でも、最終的にこの名前で環境変数として見えるように揃えると混乱が減ります）

## 6) App Service (Web App) へのデプロイ（GitHub Actions）

`azure/login`（OIDC/サービスプリンシパル）が未設定だと「No subscriptions found」になりやすいので、デモでは **Publish Profile** を使うのが最短です。

- Workflow: [.github/workflows/main_app-sre-demo.yml](.github/workflows/main_app-sre-demo.yml)
- GitHub Secret: `AZURE_WEBAPP_PUBLISH_PROFILE`
  - Azure Portal → App Service → 「発行プロファイルの取得」からダウンロードした XML を、そのまま Secret の値に貼り付けます
