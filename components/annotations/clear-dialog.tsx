"use client";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

type Props = {
  open: boolean;
  count: number;
  container?: Element | DocumentFragment | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

export function ClearAllDialog({ open, count, container, onOpenChange, onConfirm }: Props) {
  return <AlertDialog open={open} onOpenChange={onOpenChange}>
    <AlertDialogContent container={container} size="sm" className="border-border bg-popover text-foreground">
      <AlertDialogHeader>
        <AlertDialogTitle>Стереть все пометки?</AlertDialogTitle>
        <AlertDialogDescription>Будут удалены все пометки ({count}), включая пометки других участников. Вернуть их можно кнопкой «Отменить» (Ctrl+Z).</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel className="border-border bg-transparent text-foreground hover:bg-accent hover:text-foreground">Отмена</AlertDialogCancel>
        <AlertDialogAction variant="destructive" onClick={onConfirm}>Стереть всё</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
