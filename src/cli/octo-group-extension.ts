import type { ExtensionFactory } from "../../pi-mono/packages/coding-agent/src/index.ts";
import type { RegisteredGroup } from "../db";
import { GroupService } from "../group-service";
import { formatGroupOption, selectCliGroup } from "./group-selector";
import { OctoCliRuntimeHost } from "./octo-cli-runtime-host";

export interface OctoGroupExtensionOptions {
  groupService: GroupService;
  getRuntimeHost(): OctoCliRuntimeHost | null;
}

function listSortedCliGroups(groupService: GroupService): RegisteredGroup[] {
  return groupService.listCliGroups();
}

function findCliGroup(
  groupService: GroupService,
  rawQuery: string,
): RegisteredGroup | null {
  const query = rawQuery.trim();
  if (!query) {
    return null;
  }

  const groups = listSortedCliGroups(groupService);
  const exactFolder = groups.find((group) => group.folder === query);
  if (exactFolder) {
    return exactFolder;
  }

  const exactName = groups.find((group) => group.name === query);
  if (exactName) {
    return exactName;
  }

  const prefixMatches = groups.filter((group) => group.folder.startsWith(query));
  if (prefixMatches.length === 1) {
    return prefixMatches[0]!;
  }

  return null;
}

function buildGroupCompletions(groupService: GroupService, prefix: string) {
  const normalizedPrefix = prefix.trim();
  return listSortedCliGroups(groupService)
    .filter((group) =>
      normalizedPrefix.length === 0 ||
      group.folder.startsWith(normalizedPrefix) ||
      group.name.startsWith(normalizedPrefix)
    )
    .map((group) => ({
      value: group.folder,
      label: formatGroupOption(group),
    }));
}

function getRuntimeHost(
  options: OctoGroupExtensionOptions,
): OctoCliRuntimeHost {
  const runtimeHost = options.getRuntimeHost();
  if (!runtimeHost) {
    throw new Error("Octo CLI runtime host is not ready");
  }

  return runtimeHost;
}

async function resolveSwitchTarget(
  groupService: GroupService,
  runtimeHost: OctoCliRuntimeHost,
  ui: Parameters<ExtensionFactory>[0] extends never ? never : {
    select: (
      title: string,
      options: string[],
      opts?: { timeout?: number; signal?: AbortSignal },
    ) => Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  },
  rawArgs: string,
): Promise<RegisteredGroup | undefined> {
  const query = rawArgs.trim();
  if (query) {
    const directMatch = findCliGroup(groupService, query);
    if (!directMatch) {
      ui.notify(`CLI group not found: ${query}`, "error");
      return undefined;
    }

    return directMatch;
  }

  const selected = await selectCliGroup(
    ui,
    listSortedCliGroups(groupService),
    runtimeHost.getCurrentGroup().folder,
    "Switch CLI Group",
  );

  if (!selected) {
    return undefined;
  }

  return selected;
}

export function createOctoGroupExtension(
  options: OctoGroupExtensionOptions,
): ExtensionFactory {
  return async (pi) => {
    pi.registerCommand("new-group", {
      description: "Create a new Octo CLI group and switch to it",
      handler: async (args, ctx) => {
        const runtimeHost = getRuntimeHost(options);
        const requestedName = args.trim() || await ctx.ui.input(
          "New CLI Group",
          "Optional group name",
        ) || "";

        await ctx.waitForIdle();
        const created = options.groupService.createCliGroup({
          name: requestedName || undefined,
        });
        await runtimeHost.switchGroup(created);
        ctx.ui.notify(`Switched to ${created.folder}`, "info");
      },
    });

    pi.registerCommand("groups", {
      description: "List Octo CLI groups and switch via picker",
      handler: async (_args, ctx) => {
        const runtimeHost = getRuntimeHost(options);
        const selected = await selectCliGroup(
          ctx.ui,
          listSortedCliGroups(options.groupService),
          runtimeHost.getCurrentGroup().folder,
          "CLI Groups",
        );

        if (!selected) {
          return;
        }

        if (selected.folder === runtimeHost.getCurrentGroup().folder) {
          ctx.ui.notify(`Current group: ${selected.folder}`, "info");
          return;
        }

        await ctx.waitForIdle();
        await runtimeHost.switchGroup(selected);
        ctx.ui.notify(`Switched to ${selected.folder}`, "info");
      },
    });

    pi.registerCommand("switch-group", {
      description: "Switch to another Octo CLI group",
      getArgumentCompletions: (prefix) => buildGroupCompletions(options.groupService, prefix),
      handler: async (args, ctx) => {
        const runtimeHost = getRuntimeHost(options);
        const targetGroup = await resolveSwitchTarget(
          options.groupService,
          runtimeHost,
          ctx.ui,
          args,
        );

        if (!targetGroup) {
          return;
        }

        if (targetGroup.folder === runtimeHost.getCurrentGroup().folder) {
          ctx.ui.notify(`Already in ${targetGroup.folder}`, "info");
          return;
        }

        await ctx.waitForIdle();
        await runtimeHost.switchGroup(targetGroup);
        ctx.ui.notify(`Switched to ${targetGroup.folder}`, "info");
      },
    });

    pi.registerCommand("rename-group", {
      description: "Rename the current Octo CLI group",
      handler: async (args, ctx) => {
        const runtimeHost = getRuntimeHost(options);
        const currentGroup = runtimeHost.getCurrentGroup();
        const requestedName = args.trim() || await ctx.ui.input(
          "Rename CLI Group",
          currentGroup.name,
        );

        if (!requestedName?.trim()) {
          return;
        }

        const renamed = options.groupService.renameGroup(
          currentGroup.folder,
          requestedName,
        );
        ctx.ui.notify(`Renamed ${renamed.folder} to ${renamed.name}`, "info");
      },
    });
  };
}

export const __test__ = {
  buildGroupCompletions,
  findCliGroup,
};
