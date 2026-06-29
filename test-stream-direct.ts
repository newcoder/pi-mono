import { loadModelRegistry, selectDefaultModel } from './packages/trading-agent/dist/core/model-config.js';
import { streamSimple } from '@mariozechner/pi-ai';

async function main() {
    const registry = loadModelRegistry();
    const model = selectDefaultModel(registry);
    console.log('Selected model:', model?.provider, '/', model?.id);
    console.log('API:', model?.api);
    console.log('Base URL:', model?.baseUrl);

    const auth = await registry.getApiKeyAndHeaders(model!);
    console.log('Auth ok:', auth.ok);
    if (!auth.ok) {
        console.error('Auth error:', auth.error);
        return;
    }
    console.log('API key present:', !!auth.apiKey);
    console.log('Headers:', auth.headers);

    console.log('\nTrying streamSimple...');
    try {
        const stream = streamSimple(model!, [
            { role: 'user', content: [{ type: 'text', text: 'Hello' }] }
        ], { apiKey: auth.apiKey, headers: auth.headers });

        for await (const event of stream) {
            console.log('Event:', event.type, JSON.stringify(event).slice(0, 200));
            if (event.type === 'stop') {
                console.log('Stop reason:', event.stopReason);
                break;
            }
        }
    } catch (err) {
        console.error('Stream error:', err);
    }
}

main().catch(console.error);
