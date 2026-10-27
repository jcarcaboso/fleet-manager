<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BrandMark from '@/components/BrandMark.vue';
import Icon from '@/components/Icon.vue';
import { useSession } from '@/context';
import { safeRedirect } from '@/router';

/**
 * Sign in with an Operator token. The token is read from the field, the field is cleared at once, and it is posted a single
 * time to start a cookie session; it is never held in reactive state, storage, the URL or the router state.
 * After sign-in the visitor returns to `?redirect=` (a same-app path) or to the machines.
 */
const session = useSession();
const route = useRoute();
const router = useRouter();

const input = ref<HTMLInputElement | null>(null);
const notice = session.takeNotice();
const message = ref<{ text: string; err: boolean }>({ text: notice?.text ?? '', err: notice?.err ?? false });
const busy = ref(false);

onMounted(async () => {
  await nextTick();
  input.value?.focus();
});

async function submit(): Promise<void> {
  const field = input.value;
  if (!field || busy.value) return;
  const token = field.value;
  field.value = '';
  if (!token) {
    message.value = { text: 'Enter your Operator token.', err: true };
    field.focus();
    return;
  }
  busy.value = true;
  message.value = { text: 'Signing in…', err: false };
  try {
    await session.login(token);
    await router.replace(safeRedirect(route.query.redirect) ?? { name: 'machines' });
  } catch (e) {
    busy.value = false;
    message.value = { text: e instanceof Error ? e.message : 'Sign-in failed.', err: true };
    field.focus();
  }
}
</script>

<template>
  <div class="login-wrap">
    <section class="login-card" aria-labelledby="login-title">
      <span class="login-logo"><BrandMark /></span>
      <h1 id="login-title" tabindex="-1">Sign in</h1>
      <p class="login-sub">Use your Operator token to manage this Fleet Server.</p>
      <form class="form" novalidate @submit.prevent="submit">
        <label for="operator-token">Operator token</label>
        <input id="operator-token" ref="input" class="input" type="password" required autocomplete="off" spellcheck="false" maxlength="1024" aria-describedby="login-msg">
        <p id="login-msg" class="field-msg" :class="{ 'is-err': message.err }" role="alert">{{ message.text }}</p>
        <button class="btn btn-primary" type="submit" :disabled="busy"><Icon name="key" />Sign in</button>
      </form>
      <p class="muted small">The token is sent once to start a session. It is never stored in this browser.</p>
    </section>
  </div>
</template>
