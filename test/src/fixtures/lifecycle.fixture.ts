import { HttpClient } from '../../../src/http/httpClient.js';
import { createTestClient } from './httpClient.fixture.js';
import { TestClientOptions } from './types.js';

export async function withClosedClient(client: HttpClient, callback: () => Promise<void>): Promise<void> {
    try {
        await callback();
    } finally {
        await client.close();
    }
}

export async function withClient(
    run: (client: HttpClient) => Promise<void>,
    optionsOverrides: Partial<TestClientOptions> = {},
): Promise<void> {
    const client = await createTestClient(optionsOverrides);

    try {
        await run(client);
    } finally {
        await client.close();
    }
}
