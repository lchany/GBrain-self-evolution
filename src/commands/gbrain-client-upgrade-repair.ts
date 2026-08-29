import {
  repairManagedClientInstallations,
  type ClientRepairResult,
  type InstallClientDeps,
} from './gbrain-client-installer.ts';

export type PostUpgradeClientRepairDeps = InstallClientDeps & {
  readonly warn?: (message: string) => void;
};

export async function runClientRepairForPostUpgrade(
  deps: PostUpgradeClientRepairDeps = {},
): Promise<ClientRepairResult> {
  const { warn = (message: string) => console.warn(message), ...installerDeps } = deps;
  const result = repairManagedClientInstallations(installerDeps);
  if (result.status === 'unrecoverable') {
    const issues = result.check.surfaces
      .flatMap((surface) => surface.issues.map((issue) => `${surface.name}:${issue}`))
      .join(',');
    warn(`[gbrain] client_guard_repair_failed:${issues || 'experience_choice_conflict'}; run gbrain install-client --experience-hook or --no-experience-hook`);
  }
  return result;
}
