import { DefaultAzureCredential } from '@azure/identity';
import { CosmosClient } from '@azure/cosmos';
import { randomUUID } from 'node:crypto';

let _client;
let _container;

function getCosmosEnv() {
    const endpoint = process.env.COSMOS_ENDPOINT ?? process.env.CONFIGURATION__AZURECOSMOSDB__ENDPOINT;
    const key = process.env.COSMOS_KEY;
    const connectionString =
        process.env.COSMOS_CONNECTION_STRING ??
        // App Service "Connection strings" (DocumentDB) surface as DOCDBCONNSTR_<name>.
        // If you set a Connection string named "COSMOS_CONNECTION_STRING" or "COSMOS", these will work.
        process.env.DOCDBCONNSTR_COSMOS_CONNECTION_STRING ??
        process.env.DOCDBCONNSTR_COSMOS;

    const databaseName = process.env.COSMOS_DATABASE_ID ?? process.env.CONFIGURATION__AZURECOSMOSDB__DATABASENAME ?? 'appdb';
    const containerName = process.env.COSMOS_CONTAINER_ID ?? process.env.CONFIGURATION__AZURECOSMOSDB__CONTAINERNAME ?? 'items';

    return { endpoint, key, connectionString, databaseName, containerName };
}

export function getCosmosClientInfo() {
    const { endpoint, connectionString, databaseName, containerName } = getCosmosEnv();
    return { endpoint, connectionString, databaseName, containerName };
}

export function resetCosmosClientsForTestsOnly() {
    _client = undefined;
    _container = undefined;
}

export async function getContainer() {
    if (_container) return _container;

    const { endpoint, key, connectionString, databaseName, containerName } = getCosmosEnv();
    if (!endpoint && !connectionString) {
        throw new Error('Cosmos connection info missing. Set COSMOS_ENDPOINT (and optionally COSMOS_KEY) or COSMOS_CONNECTION_STRING.');
    }

    if (!_client) {
        const retryOptions = {
            // Demo-first: surface 429s instead of retrying.
            maxRetryAttemptsOnThrottledRequests: 0,
            maxRetryWaitTimeInSeconds: 0,
        };

        if (connectionString) {
            _client = new CosmosClient({ connectionString, retryOptions });
        } else if (key) {
            _client = new CosmosClient({ endpoint, key, retryOptions });
        } else {
            const credential = new DefaultAzureCredential();
            _client = new CosmosClient({ endpoint, aadCredentials: credential, retryOptions });
        }
    }

    const database = _client.database(databaseName);
    _container = database.container(containerName);
    return _container;
}

function clampInt(value, { min, max, fallback }) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function getBurstMaxItems() {
    // Safety guardrail: allow raising/lowering without code changes.
    // Default is higher than 1000 so demos can push harder.
    return clampInt(process.env.BURST_MAX_ITEMS, { min: 1, max: 20_000, fallback: 5_000 });
}

export async function runBurst({ mode, items, pk, concurrency }) {
    const container = await getContainer();

    const normalizedMode = (mode ?? 'hot').toLowerCase();
    const concurrencyFallback = clampInt(process.env.BURST_CONCURRENCY ?? undefined, { min: 1, max: 50, fallback: 1 });
    const normalizedConcurrency = clampInt(concurrency, { min: 1, max: 50, fallback: concurrencyFallback });
    const requestedItems = Number.parseInt(String(items ?? ''), 10);
    const maxItems = getBurstMaxItems();
    const operations = clampInt(items, { min: 1, max: maxItems, fallback: 25 });
    const basePk = (pk && String(pk).length > 0) ? String(pk) : 'hot-1';

    const startedAt = Date.now();
    const perOperationTimeoutMs = 15_000;
    const maxTotalElapsedMs = 180_000;
    const results = {
        mode: normalizedMode,
        itemsRequested: Number.isNaN(requestedItems) ? operations : requestedItems,
        itemsEffective: operations,
        itemsMax: maxItems,
        itemsCapped: !Number.isNaN(requestedItems) && requestedItems > operations,
        concurrency: normalizedConcurrency,
        pk: basePk,
        ok: 0,
        throttled429: 0,
        otherErrors: 0,
        totalRequestCharge: 0,
        lastRetryAfterMs: undefined,
    };

    async function runOne(i) {
        const partitionKeyValue = normalizedMode === 'spread'
            ? `${basePk}-${i}-${randomUUID().slice(0, 8)}`
            : basePk;

        const id = randomUUID();
        const item = {
            id,
            // Container's partition key path is expected to be `/pk`.
            pk: partitionKeyValue,
            // Optional: keep a secondary field for human readability.
            category: partitionKeyValue,
            name: `burst-${i}`,
            quantity: i,
            price: i,
            clearance: false,
            ts: Date.now(),
        };

        try {
            const upsertAbort = new AbortController();
            const upsertTimer = setTimeout(() => upsertAbort.abort(), perOperationTimeoutMs);
            let upsertResponse;
            try {
                upsertResponse = await container.items.upsert(item, { abortSignal: upsertAbort.signal });
            } finally {
                clearTimeout(upsertTimer);
            }
            results.totalRequestCharge += upsertResponse.requestCharge ?? 0;

            const readAbort = new AbortController();
            const readTimer = setTimeout(() => readAbort.abort(), perOperationTimeoutMs);
            let readResponse;
            try {
                readResponse = await container.item(id, partitionKeyValue).read({ abortSignal: readAbort.signal });
            } finally {
                clearTimeout(readTimer);
            }
            results.totalRequestCharge += readResponse.requestCharge ?? 0;

            results.ok++;
        } catch (error) {
            const code = error?.code;
            if (code === 429) {
                results.throttled429++;
                results.lastRetryAfterMs = error?.retryAfterInMs ?? error?.retryAfterMilliseconds;
            } else {
                results.otherErrors++;
            }
        }
    }

    // Drive a bounded number of async operations in flight.
    const inFlight = new Set();
    let nextIndex = 0;
    while ((nextIndex < operations) || (inFlight.size > 0)) {
        if (Date.now() - startedAt > maxTotalElapsedMs) {
            break;
        }

        while (nextIndex < operations && inFlight.size < normalizedConcurrency) {
            const i = nextIndex++;
            let p;
            p = runOne(i).finally(() => inFlight.delete(p));
            inFlight.add(p);
        }

        if (inFlight.size > 0) {
            await Promise.race(inFlight);
        }
    }

    results.elapsedMs = Date.now() - startedAt;
    return results;
}

export async function start(emit) {
    // <create_client>
    const { endpoint, databaseName, containerName } = getCosmosClientInfo();
    console.log(`ENDPOINT: ${endpoint}`);
    const container = await getContainer();
    // </create_client>
    emit('Current Status:\tStarting...');

    emit(`Cosmos endpoint:\t${endpoint ?? '(not set)'}`);
    emit(`Cosmos db/container:\t${databaseName}/${containerName}`);

    emit(`Get container:\t${container.id}`);

    {
        var item = {
            'id': 'aaaaaaaa-0000-1111-2222-bbbbbbbbbbbb',
            'pk': 'gear-surf-surfboards',
            'category': 'gear-surf-surfboards',
            'name': 'Yamba Surfboard',
            'quantity': 12,
            'price': 850.00,
            'clearance': false
        };

        var response = await container.items.upsert(item);

        if (response.statusCode == 200 || response.statusCode == 201) {
            emit(`Upserted item:\t${JSON.stringify(response.resource)}`);
        }
        emit(`Status code:\t${response.statusCode}`);
        emit(`Request charge:\t${response.requestCharge}`);        
    }

    {
        var item = {
            'id': 'bbbbbbbb-1111-2222-3333-cccccccccccc',
            'pk': 'gear-surf-surfboards',
            'category': 'gear-surf-surfboards',
            'name': 'Kiama Classic Surfboard',
            'quantity': 25,
            'price': 790.00,
            'clearance': true
        };

        var response = await container.items.upsert(item);
        var { resource } = response;
        emit(`Upserted item:\t${JSON.stringify(resource)}`);
        emit(`Status code:\t${response.statusCode}`);
        emit(`Request charge:\t${response.requestCharge}`);  
    }

    {
        var id = 'aaaaaaaa-0000-1111-2222-bbbbbbbbbbbb';
        var partitionKey = 'gear-surf-surfboards';

        var response = await container.item(id, partitionKey).read();
        var read_item = response.resource;

        emit(`Read item id:\t${read_item.id}`);
        emit(`Read item:\t${JSON.stringify(read_item)}`);
        emit(`Status code:\t${response.statusCode}`);
        emit(`Request charge:\t${response.requestCharge}`);
    }

	{
        const querySpec = {
            query: 'SELECT * FROM c WHERE c.pk = @pk',
            parameters: [
                {
                name: '@pk',
                value: 'gear-surf-surfboards'
                }
            ]
        };
        
        var response = await container.items.query(querySpec).fetchAll();
        for (var item of response.resources) {
            emit(`Found item:\t${item.name}\t${item.id}`);
        }
        emit(`Request charge:\t${response.requestCharge}`);
    }

    emit('Current Status:\tFinalizing...');
}