export type RoomKind = "meeting" | "webinar";
export type Role = "host" | "speaker" | "viewer";
export type Tool = "pen" | "line" | "arrow" | "dashed" | "marker" | "rect" | "circle" | "triangle" | "hexagon" | "text" | "eraser";
export type Point = [number, number];
export type AnnotationPayload = { color: string; points?: Point[]; point?: Point; text?: string; strokeWidth?: number };
export type Annotation = { id: string; author_id: string; kind: Tool; payload: string; created_at: number };
export type Member = { id: string; name: string; role: Role; can_annotate: number; raised_hand: number; removed: number };
export type Message = { id: string; member_id: string; name: string; body: string; created_at: number };
export type RoomState = {
  room: { id: string; kind: RoomKind; status: string; activeShareId: string | null; activeShareOwner: string | null; annotationsEnabled: boolean };
  members: Member[];
  messages: Message[];
  annotations: Annotation[];
  recording: { status: string; url: string | null } | null;
};
