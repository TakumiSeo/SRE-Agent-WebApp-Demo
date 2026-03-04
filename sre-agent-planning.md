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
  - 注意: サーバ側で `items` の上限を持つ（暴走防止）
    - Node このリポ: `BURST_MAX_ITEMS`（既定 5000、最大 20000）

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
  int maxItems = int.TryParse(Environment.GetEnvironmentVariable("BURST_MAX_ITEMS"), out var m)
    ? Math.Clamp(m, 1, 20000)
    : 5000;
  int itemsParam = int.TryParse(req.Query["items"], out var n) ? n : 25;
  int items = Math.Clamp(itemsParam, 1, maxItems);
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
      itemsRequested = itemsParam,
      itemsEffective = items,
      itemsMax = maxItems,
      itemsCapped = itemsParam > items,
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

### 5.1 Local Authorization が無効な場合（AAD 必須）

Cosmos 側で **Local Authorization (Keys)** が無効だと、`COSMOS_KEY` / 接続文字列では 403 になり
`Local Authorization is disabled. Use an AAD token...` が返ります。

この場合は **App Service の Managed Identity + Cosmos DB RBAC** で接続してください。

- App Service 側
  - System-assigned managed identity を ON
  - App settings は `COSMOS_ENDPOINT` / `COSMOS_DATABASE_ID` / `COSMOS_CONTAINER_ID` を設定
  - `COSMOS_KEY` は **設定しない**（または削除）
- Cosmos DB 側
  - 上記 managed identity に、**データプレーン用のロール**を割り当て
    - 例: `Cosmos DB Built-in Data Contributor`（読み書き） / `Cosmos DB Built-in Data Reader`（読み取り）
  - 割り当てスコープは Cosmos DB アカウント（または database/container）
  - 注意: 「Cosmos DB アカウントの閲覧者ロール」「Cosmos DB 演算子」など *管理プレーン(IAM)* のロールだけでは、SDK から item の read/write はできません
  - ポータルで **データプレーンRBAC（sql role assignment）** の管理 UI が表示されないことがあります。その場合は Azure CLI で割り当てるのが確実です。

例（Azure CLI）:

```bash
# 1) App Service の managed identity (principalId) を取得
az webapp identity show -g <rg> -n <appServiceName> --query principalId -o tsv

# 2) Data Contributor の roleDefinitionId を取得
az cosmosdb sql role definition list -g <rg> -a <cosmosAccountName> \
  --query "[?roleName=='Cosmos DB Built-in Data Contributor'].id | [0]" -o tsv

# 3) ロール割り当て作成（アカウント全体に付与するなら scope は '/'）
az cosmosdb sql role assignment create -g <rg> -a <cosmosAccountName> \
  --scope "/" \
  --principal-id <principalId> \
  --role-definition-id <roleDefinitionId>

# 4) 確認
az cosmosdb sql role assignment list -g <rg> -a <cosmosAccountName>
```

このリポの Node 実装は `COSMOS_KEY` が無い場合、`DefaultAzureCredential`（Managed Identity）で接続します。

az cosmosdb sql role assignment create -g <rg> -a <cosmoddb>  --scope "/" --principal-id  <app principle id> --role-definition-id /subscriptions/<subscription id>/resourceGroups/<rg>/providers/Microsoft.DocumentDB/databaseAccounts/cdbsreagentdemo/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002

接続文字列で渡したい場合:

- App settings に `COSMOS_CONNECTION_STRING` を入れるのが分かりやすい
- App Service の “Connection strings” を使う場合は、名前を `COSMOS_CONNECTION_STRING`（または `COSMOS`）にすると `DOCDBCONNSTR_...` 経由でも自動的に読めます

## 6) App Service (Web App) へのデプロイ（GitHub Actions）

`azure/login`（OIDC/サービスプリンシパル）が未設定だと「No subscriptions found」になりやすいので、デモでは **Publish Profile** を使うのが最短です。

- Workflow: [.github/workflows/main_app-sre-demo.yml](.github/workflows/main_app-sre-demo.yml)
- GitHub Secret: `AZURE_WEBAPP_PUBLISH_PROFILE`
  - Azure Portal → App Service → 「発行プロファイルの取得」からダウンロードした XML を、そのまま Secret の値に貼り付けます
