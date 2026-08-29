import { Command } from "commander";
import { getSecret } from "../../core/db.ts";
import { datasourceIdentity, decodeInvite, encodeInvite } from "../../core/invite.ts";
import { findConfigLinkingDatasource } from "../../collab.ts";
import { joinFromInvite } from "../../setup.ts";
import { listInstances, requireInstance, resolveExistingConfig } from "../context.ts";
import { selectedConfig, withConfigOption } from "../options.ts";

/**
 * Collaboration surface: share the datasource one config points at (`invite`),
 * or set up a new local config linked to a shared datasource (`join`). Also the
 * deprecated `instances` alias of `config list`.
 */
export function registerCollab(program: Command): void {
  withConfigOption(
    program
      .command("invite [config]")
      .summary("print a shareable string modelling a config's datasource")
      .description(
        "Print one opaque, versioned string modelling this config's datasource — source kind, adapter config, and the access secret. Guidance and the secret warning go to stderr so the string pipes cleanly to stdout.",
      ),
  ).action(async (configArg: string | undefined, opts) => {
    const slug = await resolveExistingConfig(configArg ?? selectedConfig(opts));
    const { ref, db } = requireInstance(slug);
    const sourceRow = db.prepare("SELECT id, kind, config FROM sources LIMIT 1").get() as
      | { id: string; kind: string; config: string }
      | undefined;
    if (!sourceRow) throw new Error(`config "${ref.slug}" has no source to share — run faktory setup first`);
    const config = JSON.parse(sourceRow.config) as Record<string, unknown>;
    const secretKey = (config.tokenSecret as string | undefined) ?? "notion.token";
    const secret = getSecret(db, secretKey) ?? undefined;
    const invite = encodeInvite({ v: 1, kind: sourceRow.kind, config, secret });
    console.error(
      `invite for config "${ref.slug}" (datasource ${datasourceIdentity(sourceRow.kind, config)}).\n` +
        (secret ? "⚠ this string embeds an access token — share it over a trusted channel, never commit it.\n" : "") +
        "the recipient runs: faktory join <string>\n",
    );
    console.log(invite);
  });

  withConfigOption(
    program
      .command("join <string>")
      .description("set up a new local config linked to a shared datasource (bails on duplicates)"),
  ).action(async (str: string, opts) => {
    const invite = decodeInvite(str);
    const identity = datasourceIdentity(invite.kind, invite.config);
    const existing = findConfigLinkingDatasource(identity);
    if (existing) throw new Error(`config "${existing}" already links this datasource (${identity}) — nothing to join`);
    const joined = await joinFromInvite(invite, { name: selectedConfig(opts) });
    console.log(joined);
  });

  program
    .command("instances", { hidden: true })
    .description("deprecated alias of `config list`")
    .action(() => {
      for (const slug of listInstances()) console.log(slug);
    });
}
