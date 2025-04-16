export const isLocalhost = () =>
  /^localhost$|^127(?:\.[0-9]+){0,2}\.[0-9]+$|^(?:0*:)*?:?0*1$/.test(
    window.location.hostname
  ) || window.location.protocol === "file:";
