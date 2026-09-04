import { loadModelRegistry, selectDefaultModel } from './packages/trading-agent/dist/core/model-config.js';
import { streamSimple } from '@mariozechner/pi-ai';

async function main() {
    const registry = loadModelRegistry();
    const model = selectDefaultModel(registry);
    console.log('Model:', model?.provider, '/', model?.id);

    const auth = await registry.getApiKeyAndHeaders(model!);
    if (!auth.ok) {
        console.error('Auth error:', auth.error);
        return;
    }

    console.log('Sending with proper Context object...');
    const stream = streamSimple(model!, {
        messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }]
    }, { apiKey: auth.apiKey, headers: auth.headers });

    for await (const event of stream) {
        if (event.type === 'text_delta') {
            process.stdout.write(event.delta);
        } else if (event.type === 'error') {
            console.log('\nERROR:', JSON.stringify(event, null, 2).slice(0, 500));
        } else if (event.type === 'stop') {
            console.log('\nSTOP:', event.stopReason);
        } else {
            console.log('Event:', event.type);
        }
    }
}

main().catch(console.error);
