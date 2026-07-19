'use strict';

const path = require('path');
const os = require('os');
const { debugLog } = require('./debug-log');

let _pipeline = null;
let _model = null;
let _loadFailed = false;

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;

function getModelDir() {
  return process.env.DEVGUARD_MODEL_DIR ||
    path.join(os.homedir(), '.devguard', 'models');
}

function isModelReady() {
  return _model !== null;
}

async function loadModel() {
  if (_model) return _model;
  if (_loadFailed) return null;

  try {
    const modelDir = getModelDir();
    const fs = require('fs');
    if (!fs.existsSync(modelDir)) {
      try { fs.mkdirSync(modelDir, { recursive: true }); } catch {
        _loadFailed = true;
        debugLog('embedding', 'Cannot create model dir', { modelDir });
        return null;
      }
    }

    if (!_pipeline) {
      const { pipeline, env } = require('@xenova/transformers');
      env.cacheDir = modelDir;
      env.allowLocalModels = true;
      env.allowRemoteModels = !process.env.DEVGUARD_OFFLINE;
      _pipeline = pipeline;
    }

    debugLog('embedding', 'Loading model', { model: MODEL_ID, cacheDir: getModelDir() });
    _model = await _pipeline('feature-extraction', MODEL_ID, {
      quantized: true,
    });
    debugLog('embedding', 'Model loaded successfully');
    return _model;
  } catch (err) {
    _loadFailed = true;
    debugLog('embedding', 'Model load failed', { error: String(err) });
    return null;
  }
}

async function encode(text) {
  if (!_model) return null;
  if (!text || typeof text !== 'string') return null;

  try {
    const output = await _model(text, { pooling: 'mean', normalize: true });
    const float32 = output.data;
    return Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
  } catch (err) {
    debugLog('embedding', 'Encode failed', { error: String(err) });
    return null;
  }
}

function cosineSimilarity(bufA, bufB) {
  if (!bufA || !bufB) return 0;
  if (bufA.byteLength !== bufB.byteLength) return 0;

  const a = new Float32Array(bufA.buffer, bufA.byteOffset, bufA.byteLength / 4);
  const b = new Float32Array(bufB.buffer, bufB.byteOffset, bufB.byteLength / 4);

  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return isNaN(dot) ? 0 : dot;
}

function findSimilarPairs(embeddings, threshold) {
  if (!embeddings || embeddings.length < 2) return [];

  const pairs = [];
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      const sim = cosineSimilarity(embeddings[i].buffer, embeddings[j].buffer);
      if (sim >= threshold) {
        pairs.push({ a: embeddings[i].id, b: embeddings[j].id, similarity: sim });
      }
    }
  }
  return pairs;
}

function _resetForTest() {
  _pipeline = null;
  _model = null;
  _loadFailed = false;
}

module.exports = {
  loadModel,
  encode,
  cosineSimilarity,
  findSimilarPairs,
  isModelReady,
  getModelDir,
  EMBEDDING_DIM,
  _resetForTest,
};
