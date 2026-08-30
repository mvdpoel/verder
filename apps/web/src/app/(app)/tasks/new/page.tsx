import { TaskForm } from "@/components/task-form";
import { taskFormOptions } from "../form-options";
import { PageTitle } from "@/components/ui";

export default async function NewTaskPage() {
  const options = await taskFormOptions();
  return (
    <div className="flex max-w-xl flex-col gap-6">
      <PageTitle>Nieuwe taak</PageTitle>
      <TaskForm options={options} />
    </div>
  );
}
