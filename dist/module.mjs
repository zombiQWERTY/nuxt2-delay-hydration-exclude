import { defineNuxtModule, createResolver, addComponentsDir, addTemplate, addPluginTemplate } from '@nuxt/kit';
import fse from 'fs-extra';
import { join, dirname, basename } from 'pathe';
import escapeRegExp from 'lodash/escapeRegExp.js';
import consola from 'consola';

// -- Unbuild CommonJS Shims --
import __cjs_url__ from 'url';
import __cjs_path__ from 'path';
import __cjs_mod__ from 'module';
const __filename = __cjs_url__.fileURLToPath(import.meta.url);
const __dirname = __cjs_path__.dirname(__filename);
const require = __cjs_mod__.createRequire(import.meta.url);


const NAME = "nuxt-delay-hydration";
const CONFIG_KEY = "delayHydration";
const MODE_DELAY_APP_INIT = "init";
const MODE_DELAY_APP_MOUNT = "mount";
const MODE_DELAY_MANUAL = "manual";

const templateUtils = (options = {}) => {
  options = {
    publishPath: join(dirname(__dirname), ".runtime"),
    ...options
  };
  const template = (r) => {
    let content = "";
    const contents = () => {
      if (content)
        return content;
      content = fse.readFileSync(r.src, { encoding: "utf-8" });
      return content;
    };
    const injectFileContents = (file, afterLine) => {
      if (!content)
        contents();
      const originalContent = content;
      const templateToInject = fse.readFileSync(file, { encoding: "utf-8" });
      const subst = `$1
${templateToInject}`;
      const regex = new RegExp(`(${escapeRegExp(afterLine)})`, "gm");
      content = content.replace(regex, subst);
      return originalContent !== content;
    };
    const publish = () => {
      fse.ensureDirSync(options.publishPath);
      const newPath = join(options.publishPath, basename(r.src));
      fse.writeFileSync(newPath, content);
      r.custom = true;
      r.originalSrc = r.src;
      r.src = newPath;
      return r;
    };
    return {
      template: r,
      contents,
      injectFileContents,
      publish
    };
  };
  const matchTemplate = (templates, id) => {
    const match = templates.find((template2) => template2.src.endsWith(join("vue-app", "template", `${id}.js`)));
    if (!match)
      return null;
    return template(match);
  };
  return {
    matchTemplate,
    template
  };
};

const logger = consola.withScope(`nuxt:${NAME}`);

const nuxtDelayHydration = defineNuxtModule({
  meta: {
    name: NAME,
    configKey: CONFIG_KEY
  },
  defaults: {
    mode: false,
    hydrateOnEvents: [],
    postIdleTimeout: {
      mobile: 6e3,
      desktop: 5e3
    },
    idleCallbackTimeout: 7e3,
    forever: false,
    debug: false,
    replayClick: false,
    replayClickMaxEventAge: 1e3
  },
  async setup(config, nuxt) {
    if (!config.hydrateOnEvents.length) {
      config.hydrateOnEvents = [
        "mousemove",
        "scroll",
        "keydown",
        "click",
        "touchstart",
        "wheel"
      ];
    }
    const { resolve } = createResolver(import.meta.url);
    nuxt.options.build.transpile.push("runtime/components");
    await addComponentsDir({
      path: resolve("runtime/components"),
      extensions: ["vue"],
      transpile: true
    });
    if (!config.mode) {
      logger.info(`\`${NAME}\` mode set to \`${config.mode}\`, disabling module.`);
      return;
    }
    if (!nuxt.options.ssr) {
      logger.warn(`\`${NAME}\` will only work for SSR apps, disabling module.`);
      return;
    }
    if (nuxt.options.vite && !nuxt.options.vite?.ssr) {
      logger.warn(`\`${NAME}\` only works with vite with SSR enabled, disabling module.`);
      return;
    }
    if (!config.debug && nuxt.options.dev) {
      logger.info(`\`${NAME}\` only runs in dev with \`debug\` enabled, disabling module.`);
      return;
    }
    if (config.debug && !nuxt.options.dev)
      logger.warn(`\`${NAME}\` debug enabled in a non-development environment.`);
    if (nuxt.options.target !== "static")
      logger.warn(`\`${NAME}\` is untested in a non-static mode, use with caution.`);
    nuxt.hook("build:before", () => {
      if (process.env.NODE_ENV !== "test")
        logger.info(`\`${NAME}\` enabled with \`${config.mode}\` mode ${config.debug ? "[Debug enabled]" : ""}`);
      nuxt.options.render.asyncScripts = true;
    });
    const delayHydrationPath = "hydration/hydrationRace.mjs";
    const replayPointerEventPath = "hydration/replayPointerEvent.mjs";
    addTemplate({
      src: resolve("runtime/template/delayHydration.mjs"),
      fileName: delayHydrationPath,
      options: config
    });
    if (config.replayClick) {
      addTemplate({
        src: resolve("runtime/template/replayPointerEvent.mjs"),
        fileName: replayPointerEventPath,
        options: config
      });
    }
    if (config.mode === MODE_DELAY_MANUAL) {
      addPluginTemplate({
        src: resolve("runtime/plugin/injectDelayHydrationApi.mjs"),
        fileName: "hydration/pluginDelayHydration.client.mjs",
        options: config
      });
    }
    const utils = templateUtils({ publishPath: resolve("../.runtime") });
    if (config.mode === MODE_DELAY_APP_INIT || config.mode === MODE_DELAY_APP_MOUNT) {
      nuxt.hook("build:templates", ({ templateVars, templatesFiles }) => {
        if (config.mode === MODE_DELAY_APP_MOUNT) {
          const template = utils.matchTemplate(templatesFiles, "client");
          if (!template)
            return;
          templateVars.delayHydrationPath = delayHydrationPath;
          templateVars.replayPointerEventPath = replayPointerEventPath;
          templateVars.hydrationConfig = config;
          template.injectFileContents(resolve("runtime/templateInjects/import.mjs"), "import Vue from 'vue'");
          template.injectFileContents(resolve("runtime/templateInjects/delayHydrationRace.mjs"), "async function mountApp (__app) {");
          template.publish();
          return;
        }
        if (config.mode === MODE_DELAY_APP_INIT) {
          const template = utils.matchTemplate(templatesFiles, "index");
          if (!template)
            return;
          templateVars.delayHydrationPath = delayHydrationPath;
          templateVars.replayPointerEventPath = replayPointerEventPath;
          templateVars.hydrationConfig = config;
          template.injectFileContents(resolve("runtime/templateInjects/import.mjs"), "import Vue from 'vue'");
          template.injectFileContents(resolve("runtime/templateInjects/delayHydrationRace.mjs"), "async function createApp(ssrContext, config = {}) {");
          template.publish();
        }
      });
    }
  }
});

export { nuxtDelayHydration as default };
