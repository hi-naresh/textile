// All Phase 2 agents. Each module lives in its own file and exports `agent: AgentModule`.
import type { AgentKey, AgentModule } from './types';
import { agent as inquiry } from './inquiry';
import { agent as orders } from './orders';
import { agent as allocation } from './allocation';
import { agent as inventory } from './inventory';
import { agent as logistics } from './logistics';
import { agent as documents } from './documents';
import { agent as costing } from './costing';
import { agent as reports } from './reports';
import { agent as credit } from './credit';

export const AGENTS: Record<AgentKey, AgentModule> = { inquiry, orders, allocation, inventory, logistics, documents, costing, reports, credit };

export const AGENT_LABEL: Record<AgentKey, string> = {
  inquiry: 'Inquiries', orders: 'Orders', allocation: 'Allocation', inventory: 'Inventory', logistics: 'Dispatch',
  documents: 'Documents', costing: 'Costing', reports: 'Reports', credit: 'Credit',
};
