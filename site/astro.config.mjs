// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { availableSlugs } from "./scripts/sync-docs.mjs";

const SITE = "https://myopenbase.app";
const REPO = "https://github.com/lukewilson2002/openbase";

// Docs generated from the repository (docs/*.md, CHANGELOG.md). releasing and changelog are
// optional: they only appear in the sidebar when the source file exists at build time.
const have = new Set(availableSlugs());
const sidebar = [
  { label: "Overview", slug: "docs" },
  { label: "Quickstart", slug: "docs/quickstart" },
  { label: "Self-hosting", slug: "docs/self-hosting" },
  { label: "Connect AI assistants", slug: "docs/mcp" },
  { label: "Automations", slug: "docs/automations" },
  { label: "API", slug: "docs/api" },
  { label: "Security", slug: "docs/security" },
  ...(have.has("releasing") ? [{ label: "Releasing (maintainers)", slug: "docs/releasing" }] : []),
  ...(have.has("changelog") ? [{ label: "Changelog", slug: "docs/changelog" }] : []),
];

const ogImage = `${SITE}/og.png`;

export default defineConfig({
  site: SITE,
  trailingSlash: "always",
  build: { format: "directory" },
  // No telemetry, no third-party requests: everything is self-hosted.
  devToolbar: { enabled: false },
  integrations: [
    starlight({
      title: "OpenBase",
      description:
        "OpenBase is a self-hosted Airtable alternative: grid, kanban, calendar and timeline views, automations, an Airtable-compatible API and a built-in MCP server, on one small server.",
      logo: {
        light: "./src/assets/brand/lockup.svg",
        dark: "./src/assets/brand/lockup-dark.svg",
        alt: "OpenBase",
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "OpenBase on GitHub", href: REPO }],
      sidebar,
      customCss: ["./src/styles/theme.css", "./src/styles/landing.css"],
      components: {
        SocialIcons: "./src/components/SocialIcons.astro",
        PageTitle: "./src/components/PageTitle.astro",
        Footer: "./src/components/Footer.astro",
      },
      expressiveCode: { shiki: { langAlias: { cron: "text" } } },
      pagination: true,
      lastUpdated: false,
      credits: false,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      head: [
        { tag: "meta", attrs: { name: "theme-color", content: "#1F5AE0" } },
        { tag: "link", attrs: { rel: "icon", href: "/favicon.ico", sizes: "48x48" } },
        { tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" } },
        { tag: "meta", attrs: { property: "og:site_name", content: "OpenBase" } },
        { tag: "meta", attrs: { property: "og:type", content: "website" } },
        { tag: "meta", attrs: { property: "og:image", content: ogImage } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        {
          tag: "meta",
          attrs: { property: "og:image:alt", content: "OpenBase: your own Airtable on one small server" },
        },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: ogImage } },
      ],
    }),
  ],
});
