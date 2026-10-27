<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import StatusGlyph from '@/components/StatusGlyph.vue';

/** Shown instead of the app when `/config.json` is missing or invalid. It needs nothing else (no router, no session). */
defineProps<{ message: string }>();
</script>

<template>
  <main id="main" class="wrap">
    <div class="empty empty--error" role="alert">
      <div class="empty-art"><StatusGlyph level="critical" kind="x" /></div>
      <h1>Configuration error</h1>
      <p>{{ message }}</p>
      <p class="muted small"><Icon name="info" />The dashboard reads <code>/config.json</code> when it starts. Set <code>FLEET_API_ORIGIN</code> on the dashboard container to the Server's origin, for example <code>https://fleet.home.arpa:7443</code>, and reload.</p>
    </div>
  </main>
</template>
