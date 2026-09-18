// game.json 校验器(零依赖,支持 schema 子集:type/required/properties/items/enum/pattern)
'use strict';

const TYPE_CHECK = {
  string: (v) => typeof v === 'string',
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  number: (v) => typeof v === 'number' && !Number.isNaN(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  null: (v) => v === null,
};

export function validateAgainstSchema(value, schema, path = 'game.json', errors = []) {
  if (schema.type && !TYPE_CHECK[schema.type]?.(value)) {
    errors.push(`${path}: 期望类型 ${schema.type},实际 ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: 值 "${value}" 不在允许范围 [${schema.enum.join(', ')}]`);
  }
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: "${value}" 不匹配模式 ${schema.pattern}`);
  }
  if (schema.required && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const req of schema.required) {
      if (value[req] === undefined) errors.push(`${path}: 缺少必填字段 "${req}"`);
    }
  }
  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (value[k] !== undefined) validateAgainstSchema(value[k], sub, `${path}.${k}`, errors);
    }
  }
  if (schema.items && Array.isArray(value)) {
    value.forEach((item, i) => validateAgainstSchema(item, schema.items, `${path}[${i}]`, errors));
  }
  return errors;
}

export function validateGameManifest(manifest) {
  // 返回 { ok, errors, warnings }
  const errors = [];
  const warnings = [];

  // 1) 通用 JSON Schema 校验(嵌入精简版 schema 定义,与 schema/game.schema.json 保持一致)
  const schema = {
    type: 'object',
    required: ['id', 'title', 'version', 'engine', 'entry'],
    properties: {
      id: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
      title: { type: 'string' },
      version: { type: 'string', pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+$' },
      description: { type: 'string' },
      genre: { type: 'string' },
      languages: { type: 'array', items: { type: 'string' } },
      engine: { type: 'string', enum: ['html-canvas', 'phaser', 'single-html', 'custom'] },
      entry: { type: 'string' },
      input: { type: 'array', items: { type: 'string', enum: ['mouse', 'touch', 'keyboard', 'gamepad'] } },
      orientation: { type: 'string', enum: ['landscape', 'portrait', 'any'] },
      mobileSupported: { type: 'boolean' },
      externalNetwork: { type: 'array', items: { type: 'string' } },
      saveVersion: { type: 'integer' },
      platforms: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['not-started', 'adapting', 'ready', 'submitted', 'reviewing', 'live'] },
            projectId: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['status'],
        },
      },
    },
  };
  validateAgainstSchema(manifest, schema, 'game.json', errors);

  // 2) 业务约束
  if (manifest.id !== manifest.id?.toLowerCase()) {
    errors.push('game.json: id 必须全小写');
  }
  if (!manifest.licenses) {
    warnings.push('game.json: 未声明 licenses 授权清单 → 代码/素材授权标为"待核实",不得标记为可公开再分发');
  }
  if (manifest.externalNetwork?.length) {
    warnings.push(`game.json: 存在外部网络依赖 [${manifest.externalNetwork.join(', ')}],静态托管/平台审核需注意`);
  }
  if (!manifest.entry) {
    errors.push('game.json: 缺少 entry');
  } else if (!manifest.entry.endsWith('.html')) {
    warnings.push(`game.json: entry "${manifest.entry}" 不是 .html,网页包可能无法直接作为入口`);
  }
  for (const [p, cfg] of Object.entries(manifest.platforms || {})) {
    if (cfg.status === 'live' && !cfg.projectId) {
      warnings.push(`game.json: 平台 ${p} 标记为 live 但缺少 projectId`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
