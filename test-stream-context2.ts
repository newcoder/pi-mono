import { loadModelRegistry, selectDefaultModel } from './packages/trading-agent/dist/core/model-config.js';
import { streamSimple } from '@mariozechner/pi-ai';

async function main() {
    const registry = loadModelRegistry();
    const model = selectDefaultModel(registry);

    const auth = await registry.getApiKeyAndHeaders(model!);

    const stream = streamSimple(model!, {
        messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }]
    }, { apiKey: auth.apiKey, headers: auth.headers });

    for await (const event of stream) {
        if (event.type === 'error') {
            const e = event as any;
            console.log('ERROR reason:', e.reason);
            console.log('ERROR message:', e.error?.errorMessage);
            console.log('ERROR full:', JSON.stringify(e.error, null, 2));
        } else if (event.type === 'stop') {
            console.log('STOP:', event.stopReason);
        } else if (event.type === 'text_delta') {
            process.stdout.write(event.delta);
        }
    }
}

main().catch(console.error);
