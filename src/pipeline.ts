// One analysis path for the app, the scripts and the tests: parsed sessions → episodes → rooms → route → mirror.

import type { Session } from './model';
import { detectEpisodes, type Episode } from './episodes';
import { buildRooms, buildRoute, Dispositions, type Room, type Route } from './rooms';
import { buildMirror, type Mirror } from './mirror';

export interface Analysis {
  sessions: Session[];
  episodes: Episode[];
  rooms: Room[];
  route: Route;
  mirror: Mirror;
}

export function analyse(sessions: Session[], opts: { importedCards?: number; dispositions?: Dispositions } = {}): Analysis {
  const episodes = sessions.flatMap(detectEpisodes);
  const rooms = buildRooms(sessions, episodes);
  const route = buildRoute(rooms, { importedCards: opts.importedCards ?? 0 });
  const mirror = buildMirror(sessions, episodes, rooms, opts.dispositions);
  return { sessions, episodes, rooms, route, mirror };
}
