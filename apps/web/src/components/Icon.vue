<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 });
const paths: Record<string, string> = {
  spark: 'M12 3l2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z M20 2v4 M18 4h4',
  settings: 'M9.4 3h5.2l.6 2.4 2.1 1.2 2.4-.7 2.6 4.5-1.8 1.7v2.4l1.8 1.7-2.6 4.5-2.4-.7-2.1 1.2-.6 2.4H9.4l-.6-2.4-2.1-1.2-2.4.7-2.6-4.5 1.8-1.7v-2.4l-1.8-1.7 2.6-4.5 2.4.7 2.1-1.2.6-2.4Z M15 13a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  sun: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5L19 19 M5 19l1.5-1.5 M17.5 6.5L19 5',
  moon: 'M20.5 14.5A9 9 0 0 1 9.5 3.5a9 9 0 1 0 11 11Z',
  mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Z M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3 M8 22h8',
  stop: 'M6 6h12v12H6V6Z',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  close: 'M6 6l12 12 M18 6L6 18',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  layers: 'M12 3l10 6-10 6L2 9l10-6Z M3 13l9 5 9-5 M3 17l9 5 9-5',
  chevron: 'M9 5l7 7-7 7',
  chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H3l2.5-4.4A8.5 8.5 0 1 1 21 11.5Z M8 10h9 M8 14h5',
  shield: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z M8.5 12l2.5 2.5 4.5-5',
  volume: 'M11 4L5 9H2v6h3l6 5V4Z M15 8a6 6 0 0 1 0 8 M18 5a10 10 0 0 1 0 14',
  warning: 'M12 3L2 21h20L12 3Z M12 9v5 M12 17v.1',
  info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M12 11v6 M12 7v.1',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M6.4 6.4A8 8 0 0 1 20 12 M4 12a8 8 0 0 0 13.6 5.6',
  keyboard: 'M3 5h18v14H3V5Z M6 9h.1 M10 9h.1 M14 9h.1 M18 9h.1 M6 12h.1 M10 12h.1 M14 12h.1 M18 12h.1 M7 15h10',
  newchat: 'M20 11v9H4V4h9 M16 3l5 5 M10 14l2-5 6-6 5 5-6 6-5 2Z',
  upload: 'M12 16V3 M7 8l5-5 5 5 M4 15v6h16v-6',
  loader: 'M21 12a9 9 0 1 1-9-9',
  check: 'M5 12l4 4L19 6'
};
</script>
<template><svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.spark" /></svg></template>
