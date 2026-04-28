#!/usr/bin/env node
/**
 * Phase 1 Verification Script
 * Tests: config loading, model selection, streaming prompt, tool execution
 */

import { loadModelRegistry, selectDefaultModel } from './dist/core/model-config.js';
import { TradingSession } from './dist/core/trading-session.js';
import { Type } from '@sinclair/typebox';

const checks = [];

function check(name, pass, detail = '') {
  checks.push({ name, pass, detail });
  const icon = pass ? '[PASS]' : '[FAIL]';
  console.log(`${icon} ${name}${detail ? ': ' + detail : ''}`);
}

async function verifyConfigLoading() {
  console.log('\n--- 1. Config Loading ---');
  const registry = loadModelRegistry();
  const error = registry.getError();
  const all = registry.getAll();
  const available = registry.getAvailable();

  check('models.json loaded', !error, error || 'OK');
  check('Has built-in models', all.some(m => m.provider === 'anthropic'), `${all.filter(m => m.provider === 'anthropic').length} anthropic models`);
  check('Has custom models', all.some(m => m.provider === 'kimi-coding'), `${all.filter(m => m.provider === 'kimi-coding').length} kimi-coding models`);
  check('Auth resolved for anthropic', available.some(m => m.provider === 'anthropic'), `${available.filter(m => m.provider === 'anthropic').length} available`);
  check('Auth resolved for kimi-coding', available.some(m => m.provider === 'kimi-coding'), `${available.filter(m => m.provider === 'kimi-coding').length} available`);
}

async function verifyModelSelection() {
  console.log('\n--- 2. Model Selection ---');
  const registry = loadModelRegistry();
  const model = selectDefaultModel(registry);

  check('Default model selected', !!model, model ? `${model.provider}/${model.id}` : 'none');
  check('Prefers custom provider', model?.provider === 'kimi-coding', `selected: ${model?.provider}`);

  // Test explicit override
  process.env.TRADING_PROVIDER = 'anthropic';
  process.env.TRADING_MODEL = 'claude-3-5-haiku-20241022';
  const explicit = selectDefaultModel(registry);
  check('Env override works', explicit?.provider === 'anthropic' && explicit?.id === 'claude-3-5-haiku-20241022');
  delete process.env.TRADING_PROVIDER;
  delete process.env.TRADING_MODEL;
}

async function verifyStreamingPrompt() {
  console.log('\n--- 3. Streaming Prompt ---');
  const registry = loadModelRegistry();
  const model = selectDefaultModel(registry);
  if (!model) {
    check('Model available for streaming', false, 'no available model');
    return;
  }
  console.log(`Using model: ${model.provider}/${model.id}`);

  const session = new TradingSession({
    model,
    baseSystemPrompt: 'You are a helpful assistant. Reply with exactly one word.',
    tools: [],
    getApiKey: (p) => registry.authStorage.getApiKey(p, { includeFallback: true }),
  });

  let streamed = '';
  let gotAgentEnd = false;

  session.on('agent_event', (ev) => {
    if (ev.type === 'message_update' && ev.assistantMessageEvent.type === 'text_delta') {
      streamed += ev.assistantMessageEvent.delta;
    }
    if (ev.type === 'agent_end') gotAgentEnd = true;
  });

  try {
    await session.prompt('Say hi.');
    await session.waitForIdle();
  } catch (err) {
    check('Prompt executed', false, err.message);
    session.dispose();
    return;
  }

  const last = session.messages.at(-1);
  check('Prompt executed', true);
  check('Received agent_end', gotAgentEnd);
  check('Streamed content', streamed.length > 0, `length=${streamed.length}`);
  check('No error', !last?.errorMessage, last?.errorMessage || 'clean');
  session.dispose();
}

async function verifyToolExecution() {
  console.log('\n--- 4. Tool Execution ---');
  const registry = loadModelRegistry();
  const model = selectDefaultModel(registry);
  if (!model) {
    check('Model available for tool test', false, 'no available model');
    return;
  }
  console.log(`Using model: ${model.provider}/${model.id}`);

  const helloTool = {
    name: 'hello',
    label: 'Hello',
    description: 'Say hello to a person. The assistant MUST use this tool when asked to greet.',
    parameters: Type.Object({ name: Type.String() }),
    execute: async (_id, params) => ({
      content: [{ type: 'text', text: `Tool result: Hello ${params.name}!` }],
      details: { name: params.name },
    }),
  };

  const session = new TradingSession({
    model,
    baseSystemPrompt: 'You have access to the hello tool. When asked to greet someone, ALWAYS use it.',
    tools: [helloTool],
    getApiKey: (p) => registry.authStorage.getApiKey(p, { includeFallback: true }),
  });

  let toolStarted = false;
  let toolEnded = false;
  let toolResult = null;

  session.on('agent_event', (ev) => {
    if (ev.type === 'tool_execution_start') { toolStarted = true; }
    if (ev.type === 'tool_execution_end') { toolEnded = true; toolResult = ev.result; }
  });

  try {
    await session.prompt('Greet Bob using the hello tool.');
    await session.waitForIdle();
  } catch (err) {
    check('Tool prompt executed', false, err.message);
    session.dispose();
    return;
  }

  const last = session.messages.at(-1);
  check('Tool prompt executed', true);
  check('Tool was called', toolStarted && toolEnded, `start=${toolStarted}, end=${toolEnded}`);
  check('Tool result captured', !!toolResult, JSON.stringify(toolResult?.content)?.slice(0, 60));
  check('Final response has content', (last?.content?.length ?? 0) > 0, `${last?.content?.length ?? 0} items`);
  session.dispose();
}

async function main() {
  console.log('Trading Agent — Phase 1 Verification');
  console.log('====================================');

  await verifyConfigLoading();
  await verifyModelSelection();
  await verifyStreamingPrompt();
  await verifyToolExecution();

  const passed = checks.filter(c => c.pass).length;
  const total = checks.length;

  console.log('\n====================================');
  console.log(`Result: ${passed}/${total} checks passed`);

  if (passed === total) {
    console.log('Phase 1 fully verified!');
    process.exitCode = 0;
  } else {
    console.log('Some checks failed. See details above.');
    process.exitCode = 1;
  }
}

main();
