import { ReactNode } from "react";
import { CalendarDays, ChartColumn, ChartGantt, GalleryHorizontalEnd, Kanban, List, Table2 } from "lucide-react";
import type { ViewType } from "../../../shared/db";

export const VIEW_ICON: Record<ViewType, ReactNode> = {
  table: <Table2 size={14} />,
  board: <Kanban size={14} />,
  list: <List size={14} />,
  gallery: <GalleryHorizontalEnd size={14} />,
  calendar: <CalendarDays size={14} />,
  timeline: <ChartGantt size={14} />,
  chart: <ChartColumn size={14} />,
};
