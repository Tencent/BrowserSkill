/** Source syntax changed in DSH's durable format v4, not in the browser protocol. */
export const BROWSER_SKILL_PRODUCER = "@wxg-prc-cpg/browser-skill-dsh-plugin";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "plugin:@wxg-prc-cpg/browser-skill-dsh-plugin": {
      kind: "plugin:@wxg-prc-cpg/browser-skill-dsh-plugin";
      form?: "notice";
      summary?: string;
    };
  }
}

export function browserSkillSource(version = 4) {
  return version < 4
    ? { kind: "plugin" as const, plugin: BROWSER_SKILL_PRODUCER }
    : { kind: "plugin:@wxg-prc-cpg/browser-skill-dsh-plugin" as const };
}
