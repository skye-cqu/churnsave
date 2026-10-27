/**
 * A minimal LangGraph-style graph runner: named nodes, explicit edges,
 * a single entry point, and a shared mutable state passed through each node.
 * Deliberately tiny (~40 lines) — the MVP agent is a linear pipeline, but the
 * abstraction keeps the door open for branching/conditional edges later.
 */
export interface AgentState {
  trace: string[];
}

type NodeFn<S extends AgentState> = (state: S) => Promise<void> | void;

export class Graph<S extends AgentState> {
  private readonly nodes = new Map<string, NodeFn<S>>();
  private readonly edges = new Map<string, string>();
  private entry: string | null = null;

  addNode(name: string, fn: NodeFn<S>): this {
    this.nodes.set(name, fn);
    return this;
  }

  addEdge(from: string, to: string): this {
    this.edges.set(from, to);
    return this;
  }

  setEntryPoint(name: string): this {
    this.entry = name;
    return this;
  }

  /** Execute the graph from the entry point, following edges until dead end. */
  async run(state: S): Promise<S> {
    let current = this.entry;
    let guard = 0;
    while (current) {
      if (++guard > 100) throw new Error("agent graph: possible cycle without terminal node");
      const fn = this.nodes.get(current);
      if (!fn) throw new Error(`agent graph: unknown node "${current}"`);
      state.trace.push(current);
      await fn(state);
      current = this.edges.get(current) ?? null;
    }
    return state;
  }
}
