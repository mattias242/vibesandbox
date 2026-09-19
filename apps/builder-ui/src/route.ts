/**
 * Vyer som fragment-adresser: `#/` är startsidan och `#/app/<id>` arbetsytan. Fragmentet når
 * aldrig servern, så en omladdning kräver inget av den utöver index.html.
 */
export type Route = { readonly view: 'start' } | { readonly view: 'app'; readonly appId: string };

const APP_ROUTE = /^#\/app\/([A-Za-z0-9_-]{1,64})$/;

export function parseRoute(hash: string): Route {
  const match = APP_ROUTE.exec(hash);
  return match?.[1] === undefined ? { view: 'start' } : { view: 'app', appId: match[1] };
}

export function appHash(appId: string): string {
  return `#/app/${appId}`;
}
