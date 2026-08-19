import { TaskForm } from "@/components/task-form";
import { taskFormOptions } from "../form-options";

export default async function NewTaskPage() {
  const options = await taskFormOptions();
  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-2xl font-bold">Add a task</h1>
      <TaskForm options={options} />
    </div>
  );
}
