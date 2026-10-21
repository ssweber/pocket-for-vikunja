// The fields of a task that each kind of request can be trusted for, and the id that a task's waiting ops are filed
// under. Both the store (app/tasks.js) and the ops use them. The store imports the ops, so these can't live in the
// store without an import cycle.
import { sync } from './sync.js';

/* The fields of a task that each kind of request can be trusted for (read, answer), as Vikunja 2.7 answers. A task
   read alone or in a list, and a PATCH reply, has every field in TASK, labels and people included. Reactions, comments
   and the comment count come only with expand=, and are null without it, which would read as "none". A new task's
   reply comes before Pocket adds its labels, people, parent and files. A saved screen holds copies made of these
   fields. */
export const TASK = [
  'id',
  'title',
  'description',
  'done',
  'done_at',
  'due_date',
  'start_date',
  'end_date',
  'repeat_after',
  'repeat_mode',
  'priority',
  'percent_done',
  'hex_color',
  'is_favorite',
  'identifier',
  'index',
  'position',
  'bucket_id',
  'cover_image_attachment_id',
  'project_id',
  'created',
  'created_by',
  'updated',
  'labels',
  'assignees',
  'attachments',
  'reminders',
  'related_tasks',
];
export const TASK_COUNT = [...TASK, 'comment_count']; // expand=comment_count
export const TASK_COUNT_REACTIONS = [...TASK_COUNT, 'reactions']; // expand=comment_count and expand=reactions
export const TASK_COMMENTS = [...TASK, 'comments']; // expand=comments
export const TASK_REACTIONS_COMMENTS = [...TASK_COMMENTS, 'reactions']; // expand=reactions and expand=comments
export const CREATED = TASK.filter(k => !['labels', 'assignees', 'related_tasks', 'attachments'].includes(k));
export const SAVED = [...TASK_REACTIONS_COMMENTS, 'comment_count'];
// The fields a write marking a repeating task done may leave, since Vikunja moves such a task on to its next dates.
export const MOVED = ['done', 'done_at', 'due_date', 'start_date', 'end_date', 'reminders'];
/* The id that the ops on task `task` are filed under in opsOn. A step still being inserted is 'pending-' + its entry's
   id until Vikunja has made it, and its own id from then on. Code that looks up a waiting step's ops goes through
   this too, or an op filed under the new id would vanish from the step's row. */
export const opsId = task => (typeof task === 'string' ? (sync.taskOf(task.replace(/^pending-/, '')) ?? task) : task);
