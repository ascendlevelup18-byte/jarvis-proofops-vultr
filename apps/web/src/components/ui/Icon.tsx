export type IconName = 'home' | 'orders' | 'customers' | 'inbox' | 'spark' | 'chart' | 'shield' | 'activity' | 'settings' | 'bell' | 'menu' | 'close' | 'arrow' | 'chevron';
const paths: Record<IconName, string> = {
 home:'m3 10 9-7 9 7v10H3Z M9 20v-7h6v7', orders:'M5 6h14l2 15H3L5 6Z M9 7V5a3 3 0 0 1 6 0v2', customers:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M17 4a4 4 0 0 1 0 7 M22 21v-2a4 4 0 0 0-3-3.87', inbox:'M3 4h18v16H3Z M3 13h5l2 3h4l2-3h5', spark:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z', chart:'M4 3v17h17 M8 15l4-5 4 2 5-7', shield:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z m-4 9 3 3 5-6', activity:'M2 12h5l3-8 4 16 3-8h5', settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z', bell:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4', menu:'M4 6h16 M4 12h16 M4 18h16', close:'m6 6 12 12 M6 18 18 6', arrow:'M5 12h14 m-5-5 5 5-5 5', chevron:'m9 5 7 7-7 7',
};
export function Icon({ name, size = 19 }: { name: IconName; size?: number }) {
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
