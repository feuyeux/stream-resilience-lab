declare const __SRL_BUILD_VERSION__: string | undefined;

export const desktopBuildVersion =
  typeof __SRL_BUILD_VERSION__ === "string" && __SRL_BUILD_VERSION__.length > 0
    ? __SRL_BUILD_VERSION__
    : "srl-dev";
