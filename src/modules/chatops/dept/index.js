/**
 * modules/chatops/dept/index.js — Registry 6 agent phòng ban (HERMES)
 */
const sales = require('./sales.agent');
const marketing = require('./marketing.agent');
const hr = require('./hr.agent');
const accounting = require('./accounting.agent');
const cskh = require('./cskh.agent');
const ops = require('./ops.agent');

const AGENTS = { SALES: sales, MARKETING: marketing, HR: hr, ACCOUNTING: accounting, CSKH: cskh, OPS: ops };

const getAgent = (deptCode) => AGENTS[String(deptCode || '').toUpperCase()] || null;
const listAgents = () => Object.values(AGENTS).map((a) => ({ code: a.code, name: a.name, description: a.description, tools: a.tools }));

module.exports = { AGENTS, getAgent, listAgents };
