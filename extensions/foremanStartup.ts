export const FOREMAN_TAB_LABEL = "Foreman";

type RenameResult = { ok: true } | { ok: false; error: { message: string } };

type StartupRenameResult =
  | { kind: "skipped"; reason: "not-startup" | "outside-herdr" }
  | { kind: "renamed" }
  | { kind: "failed"; message: string };

interface StartupRenameOptions {
  reason: string;
  tabId?: string;
  rename: (tabId: string, label: string) => RenameResult;
}

export const renameForemanTabAtStartup = ({
  reason,
  tabId,
  rename,
}: StartupRenameOptions): StartupRenameResult => {
  if (reason !== "startup") return { kind: "skipped", reason: "not-startup" };
  if (!tabId) return { kind: "skipped", reason: "outside-herdr" };

  const result = rename(tabId, FOREMAN_TAB_LABEL);
  return result.ok
    ? { kind: "renamed" }
    : { kind: "failed", message: result.error.message };
};
