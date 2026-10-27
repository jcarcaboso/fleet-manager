<script setup lang="ts">
import { computed } from 'vue';
import { platformLabel } from '@/lib/format';
import type { GlyphLevel } from '@/lib/status';

/**
 * Machine illustration for the gallery. The Server reports only a Node's platform, so there is one illustration per
 * platform (a laptop for macOS, a desktop for Linux). The art never claims a model, hostname or operating system version.
 * `health` colours the power LED. Needs the gradients of `SvgDefs` (mounted by `AppShell`).
 */
const props = defineProps<{
  node: { revoked: boolean; freshness: string; platform: string | null };
  health?: { level: GlyphLevel } | null;
}>();

export type DeviceState = 'off' | 'ghost' | 'sleep' | 'on';
const st = computed<DeviceState>(() => (props.node.revoked ? 'off' : props.node.freshness === 'never_contacted' ? 'ghost' : props.node.freshness === 'stale' ? 'sleep' : 'on'));
const wp = computed(() => (st.value === 'on' ? `url(#${props.node.platform === 'macos' ? 'wpMac' : props.node.platform === 'linux' ? 'wpLinux' : 'wpOther'})` : 'url(#wpOff)'));
const led = computed(() => (st.value === 'on' ? (props.health?.level === 'critical' ? '#ff6b5b' : props.health?.level === 'info' ? '#7fb2ff' : '#5be37d') : st.value === 'sleep' ? '#f6c25b' : '#5d6168'));
const label = computed(() => `${platformLabel(props.node.platform)} machine${st.value === 'sleep' ? ', not checking in' : st.value === 'ghost' ? ', has not checked in yet' : st.value === 'off' ? ', revoked' : ''}`);
const linux = computed(() => props.node.platform === 'linux');
</script>

<template>
  <svg class="dev" :class="`dev--${st}`" viewBox="0 0 220 150" role="img" :aria-label="label">
    <template v-if="linux">
      <ellipse cx="104" cy="140" rx="92" ry="5" fill="url(#gShadow)" />
      <path d="M78 103h18l4 29H74z" fill="url(#gAluB)" /><rect x="61" y="130" width="52" height="6" rx="3" fill="url(#gAlu)" />
      <rect x="12" y="8" width="150" height="96" rx="6" fill="#16171b" />
      <rect x="16" y="12" width="142" height="86" rx="2" :fill="wp" />
      <template v-if="st === 'on'">
        <rect x="16" y="12" width="142" height="4.5" fill="#000" opacity=".38" /><rect x="34" y="28" width="71" height="43" rx="2" fill="#fff" opacity=".14" /><rect x="80" y="40" width="60" height="39" rx="2" fill="#fff" opacity=".1" />
      </template>
      <g v-if="st === 'sleep'" class="zz" fill="#c9cdd6" font-family="system-ui,sans-serif" font-weight="700"><text x="132" y="40" font-size="13">z</text><text x="141" y="31" font-size="9">z</text></g>
      <path d="M16 12h70l-30 86H16z" fill="#fff" opacity=".05" />
      <rect x="170" y="44" width="38" height="94" rx="5" fill="url(#gDark)" />
      <circle cx="189" cy="57" r="3.2" fill="none" :stroke="led" stroke-width="1.6" />
      <rect v-for="i in 6" :key="i" x="178" :y="72 + (i - 1) * 9" width="22" height="2" rx="1" fill="#000" opacity=".28" />
    </template>
    <template v-else>
      <ellipse cx="110" cy="132" rx="96" ry="6" fill="url(#gShadow)" />
      <rect x="37" y="10" width="146" height="104" rx="9" fill="url(#gAlu)" />
      <rect x="39.5" y="12.5" width="141" height="99" rx="7" fill="#0f1013" />
      <rect x="44" y="17" width="132" height="89" rx="2.5" :fill="wp" />
      <template v-if="st === 'on'">
        <rect x="44" y="17" width="132" height="3.5" fill="#fff" opacity=".28" /><rect x="88" y="98" width="44" height="5" rx="2.5" fill="#fff" opacity=".38" /><rect x="58" y="31" width="55" height="37" rx="2.5" fill="#fff" opacity=".16" />
      </template>
      <path d="M44 17h66l-36 89H44z" fill="#fff" opacity=".06" />
      <g v-if="st === 'sleep'" class="zz" fill="#c9cdd6" font-family="system-ui,sans-serif" font-weight="700"><text x="150" y="46" font-size="13">z</text><text x="159" y="37" font-size="9">z</text></g>
      <path d="M16 114h188v3.6a5.4 5.4 0 0 1-5.4 5.4H21.4a5.4 5.4 0 0 1-5.4-5.4z" fill="url(#gAluB)" />
      <rect x="16" y="112.6" width="188" height="3.2" rx="1.6" fill="url(#gAlu)" />
      <path d="M93 113h34v1.4a2 2 0 0 1-2 2H95a2 2 0 0 1-2-2z" fill="#000" opacity=".16" />
    </template>
  </svg>
</template>
