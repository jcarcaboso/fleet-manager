<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useFleet } from '@/context';
import { installKeepFocus } from '@/composables/keepFocus';
import { modalOpenCount } from '@/composables/modalStack';
import { hideTip, installTooltipListeners } from '@/composables/tooltip';
import { useShellTitle } from '@/composables/useDocumentTitle';
import { fmtTime } from '@/lib/format';
import { NAV_KEYS, routeViewKey, type NavKey } from '@/router';
import AddMachineWizard from '@/views/Enrollment/AddMachineWizard.vue';
import Avatar from './Avatar.vue';
import BrandMark from './BrandMark.vue';
import ErrorState from './ErrorState.vue';
import Icon from './Icon.vue';
import LoadingBlock from './LoadingBlock.vue';
import StatusGlyph from './StatusGlyph.vue';
import SvgDefs from './SvgDefs.vue';
import ToastHost from './ToastHost.vue';
import Tooltip from './Tooltip.vue';

/**
 * The application shell: skip link, header with navigation, badges and user menu, the routed view, the footer, and the mount
 * points for modals (`#modal-root`), toasts and the tooltip. Ported from app.js.
 */
const { session, summary, toasts, shell, wizard } = useFleet();
const route = useRoute();
const router = useRouter();

const LABELS: Record<NavKey, string> = { machines: 'Machines', problems: 'Problems', deployments: 'Deployments', repository: 'Repository', models: 'Models', enrollment: 'Enrollment', audit: 'Audit', accounts: 'Accounts' };
/* Accounts is an admin page; other scopes do not see the entry. */
const navKeys = computed(() => NAV_KEYS.filter(k => k !== 'accounts' || session.can('admin')));
const active = computed(() => route.meta.nav);
const scope = computed(() => session.scopeLabel());
const scopeTip = computed(() => `Scope: ${scope.value}|${scope.value === 'admin' ? 'Can change anything.' : scope.value === 'operate' ? 'Can retry, sync, refresh and acknowledge or snooze problems. Cannot enroll or revoke.' : 'Can view everything. Cannot change anything.'}`);
const booting = computed(() => session.state.status === 'unknown');
const showMe = computed(() => session.signedIn);
/* While the account must replace its password only the account page is open, so there is nothing to navigate to. */
const showNav = computed(() => session.signedIn && !session.state.mustChangePassword);
const modalHidden = computed(() => modalOpenCount.value === 0);
const mainEl = ref<HTMLElement | null>(null);
const loadedNote = computed(() => (shell.loadedAt ? `Loaded ${fmtTime(shell.loadedAt)} UTC` : ''));
const signingOut = ref(false);

useShellTitle(() => route.meta.title);

/* Navigation: the first heading that mounts takes focus, a tooltip left over from the old page goes away, the footer note updates, and
   the badges refresh (at most every 20 s). afterEach runs before the new view renders, so the flag is set when its heading mounts. */
const stopAfterEach = router.afterEach((_to, _from, failure) => {
  if (failure) return;
  hideTip();
  shell.focusPending = true;
  shell.markLoaded();
  if (session.signedIn) void summary.refresh();
});
watch(() => session.signedIn, signedIn => {
  if (signedIn) {
    shell.markLoaded();
    void summary.refresh(true);
  }
});

let removeTips: (() => void) | null = null;
let removeKeepFocus: (() => void) | null = null;
onMounted(() => {
  removeTips = installTooltipListeners();
  removeKeepFocus = installKeepFocus();
  if (session.signedIn) void summary.refresh();
  window.addEventListener('pagehide', onPageHide);
});
onBeforeUnmount(() => {
  stopAfterEach();
  removeTips?.();
  removeKeepFocus?.();
  window.removeEventListener('pagehide', onPageHide);
});
/* When the page is hidden (it can come back from the back/forward cache exactly as it was) every password field is cleared and the Add
   machine wizard is closed, which drops its one-time enrollment link and stops its polling. */
function onPageHide(): void {
  document.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach(input => { input.value = ''; });
  wizard.hide();
}

function skip(): void {
  const target = mainEl.value?.querySelector<HTMLElement>('h1') ?? mainEl.value;
  target?.focus();
}
async function signOut(): Promise<void> {
  if (signingOut.value) return;
  signingOut.value = true;
  try {
    await session.logout(); // the router sends the signed-out visitor to /login
  } catch (e) {
    toasts.fail(e, 'Could not sign out');
  } finally {
    signingOut.value = false;
  }
}
const retryBoot = async (): Promise<void> => {
  shell.focusPending = true; // the button goes away; the page that appears takes the focus
  await session.retryBoot();
  await router.replace(router.currentRoute.value.fullPath);
};
</script>

<template>
  <SvgDefs />
  <a class="skip" href="#main" @click.prevent="skip">Skip to content</a>
  <header class="topbar">
    <div class="topbar-in">
      <RouterLink class="brand" :to="{ name: 'machines' }"><BrandMark /><span>Fleet</span></RouterLink>
      <nav v-if="showNav" id="nav" class="nav" aria-label="Primary">
        <RouterLink v-for="k in navKeys" :key="k" v-slot="{ href, navigate }" :to="{ name: k }" custom>
          <a :href="href" :aria-current="k === active ? 'page' : undefined" @click="navigate">
            {{ LABELS[k] }}
            <span v-if="k === 'problems' && summary.state.errors" class="nav-badge" :aria-label="`${summary.state.errors} open errors`">{{ summary.state.errors }}</span>
            <span v-else-if="k === 'models' && summary.state.modelsBad" class="nav-g" aria-label="A catalog is failing"><StatusGlyph level="warning" kind="bang" /></span>
          </a>
        </RouterLink>
      </nav>
      <div v-if="showMe" id="me" class="me">
        <span class="scope-chip" :data-tip="scopeTip"><Icon :name="scope === 'read' ? 'lock' : 'shield'" />{{ scope }}</span>
        <RouterLink class="me-link" :to="{ name: 'account' }" data-tip="Your account|Change your password and the theme."><Avatar :name="session.state.actor" class="av-me" /><span class="me-name">{{ session.state.actor }}</span></RouterLink>
        <button id="sign-out" type="button" class="btn btn-ghost btn-sm" :disabled="signingOut" @click="signOut"><Icon name="logout" />Sign out</button>
      </div>
    </div>
  </header>
  <main id="main" ref="mainEl" tabindex="-1">
    <div id="view">
      <LoadingBlock v-if="booting && !session.state.bootError" />
      <div v-else-if="session.state.bootError" class="wrap">
        <ErrorState :error="session.state.bootError" what="the dashboard" :retry="false" />
        <div class="empty-retry"><button type="button" class="btn btn-secondary" @click="retryBoot"><Icon name="retry" />Try again</button></div>
      </div>
      <RouterView v-else v-slot="{ Component, route: r }">
        <component :is="Component" :key="routeViewKey(r)" />
      </RouterView>
    </div>
  </main>
  <footer class="foot"><span>Fleet Manager · All times in UTC</span><span id="foot-note">{{ loadedNote }}</span></footer>
  <div id="modal-root" :hidden="modalHidden"></div>
  <ToastHost />
  <Tooltip />
  <AddMachineWizard v-if="wizard.open" @close="wizard.hide()" />
</template>
