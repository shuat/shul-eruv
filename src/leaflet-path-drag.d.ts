declare module "leaflet-path-drag" {
  import { Handler, Path } from "leaflet";
  export default class PathDrag extends Handler {
    constructor(path: Path);
    static makeDraggable<T extends Path>(path: T): T & { dragging: PathDrag };
  }
}
