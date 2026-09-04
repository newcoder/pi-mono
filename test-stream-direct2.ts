import { loadModelRegistry, selectDefaultModel } from './packages/trading-agent/dist/core/model-config.js';
import { streamSimple } from '@mariozechner/pi-ai';

async function main() {
    const registry = loadModelRegistry();
    const model = selectDefaultModel(registry);

    const auth = await registry.getApiKeyAndHeaders(model!);

    console.log('Trying streamSimple...');
    const stream = streamSimple(model!, [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] }
    ], { apiKey: auth.apiKey, headers: auth.headers });

    for await (const event of stream) {
        if (event.type === 'error') {
            console.log('ERROR EVENT:', JSON.stringify(event, null, 2));
        } else if (event.type === 'stop') {
            console.log('STOP:', event.stopReason);
        } else {
            console.log('Event:', event.type);
        }
    }
}

main().catch(console.error);
