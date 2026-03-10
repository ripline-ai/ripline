<script setup lang="ts">
import { useData } from "vitepress";
import DefaultTheme from "vitepress/theme";
import HomeExtra from "./HomeExtra.vue";

const { Layout: DefaultLayout } = DefaultTheme;
const { frontmatter, site } = useData();
const isHome = frontmatter.value?.layout === "home";
const videoSrc = site.value?.base ? `${site.value.base}hero-bg.mp4` : "/hero-bg.mp4";
</script>

<template>
  <DefaultLayout>
    <template v-if="isHome" #home-hero-before>
      <div class="hero-video-wrap" aria-hidden="true">
        <video
          class="hero-bg-video"
          :src="videoSrc"
          autoplay
          muted
          loop
          playsinline
        />
        <div class="hero-video-overlay" />
      </div>
    </template>
    <template v-if="isHome" #home-features-after>
      <HomeExtra />
    </template>
  </DefaultLayout>
</template>
