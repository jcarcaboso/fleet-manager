import type { EnrollmentLinkState } from '@/api/types';
import type { Step } from '@/components/StepsList.vue';
import type { GlyphKind, GlyphLevel } from '@/lib/status';

/** The alias rule of enrollment links (the Server's `invalid_alias`): nonblank, at most 200 characters. Returns the message, or `null` when fine. */
export const aliasError = (alias: string): string | null => (!alias || alias.length > 200 ? 'Choose a nonblank alias of at most 200 characters.' : null);

export const ALIAS_HINT = 'Lowercase letters, numbers and dashes work best. fleet.yml uses this name under nodes:.';

/** How a link state reads: glyph level, glyph kind, word. An unknown state reads as expired. */
export const LINK_STATE: Record<EnrollmentLinkState, readonly [GlyphLevel, GlyphKind, string]> = {
  active: ['info', 'clock', 'Active'],
  consumed: ['good', 'check', 'Used'],
  expired: ['neutral', 'minus', 'Expired'],
  revoked: ['neutral', 'ban', 'Revoked'],
};
export const linkState = (state: string): readonly [GlyphLevel, GlyphKind, string] =>
  (Object.hasOwn(LINK_STATE, state) ? LINK_STATE[state as EnrollmentLinkState] : LINK_STATE.expired);

export const EXPIRIES: ReadonlyArray<readonly [number, string]> = [[900, '15 min'], [1800, '30 min'], [3600, '1 hour']];
export type WizardPlatform = 'macos' | 'linux';

/**
 * The commands of step 2 of the wizard. They are fixed text: nothing from the Server (not the alias, not the link) is ever put
 * into a command. The link itself is shown in its own box and copied exactly as the Server sent it.
 */
export function installSteps(mac: boolean): Step[] {
  return [
    { t: `Install the Agent with Homebrew${mac ? ' (macOS 13 or newer, Apple silicon or Intel)' : ' on Linux amd64'}.`, cmd: 'brew tap jcarcaboso/fleet https://github.com/jcarcaboso/fleet-manager\nbrew install jcarcaboso/fleet/fleet-agent' },
    { t: 'Enroll. Paste the link when the Agent asks for it.', cmd: 'agent_bin="$(brew --prefix jcarcaboso/fleet/fleet-agent)/bin/fleet-agent"\n"$agent_bin" enroll --link' },
    { t: mac ? 'Start the service. On macOS it starts at login from now on.' : 'Start the service. It runs under systemd --user.', cmd: 'brew services start jcarcaboso/fleet/fleet-agent' },
    ...(mac ? [] : [{ or: true, t: 'Need it to start at boot, before anyone signs in? Enable lingering.', cmd: 'sudo loginctl enable-linger "$USER"' }]),
  ];
}
