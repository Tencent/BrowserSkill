import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";

function Item({ id }: { id: string }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      id={id}
      {...attributes}
      {...listeners}
      style={{
        width: 180,
        height: 60,
        margin: 12,
        background: "#def",
        touchAction: "none",
        transform: transform ? `translate3d(${transform.x}px,${transform.y}px,0)` : undefined,
        transition,
      }}
    >
      {id}
    </div>
  );
}
function App() {
  const [items, setItems] = useState(["alpha", "beta", "gamma"]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  function end({ active, over }: DragEndEvent) {
    if (over && active.id !== over.id)
      setItems((current) =>
        arrayMove(current, current.indexOf(String(active.id)), current.indexOf(String(over.id))),
      );
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={end}>
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <div id="items">
          {items.map((id) => (
            <Item key={id} id={id} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
createRoot(document.getElementById("app")!).render(<App />);
