# Design rules

Settled with the user on 2026-10-09. Every change to how Pocket looks or what a finger does on it is checked against
these, and a plan in `design/` says where it bends one, and why.

1. **Up and down is for finding and organizing:** scrolling, opening a card, holding a row to move it, a nudge that
   aims the add box.
2. **Left and right is for acting:** progress, done, delete.
3. **Every gesture has a tap path.** Gloves and full hands come first: whatever a swipe or a hold does, a tap can do
   too (the tick, the slot, the ⋯ menu, the sheet).
4. **A row acts the same everywhere.** Today, a project's list, search, a task's sheet and a run's steps differ only in
   what they show, not in what a finger does to a row.
5. **Progress lives where the work is.** You slide the work itself, a task or a step, and a parent adds up its
   subtasks: it has no progress of its own to set.
6. **Doing the work is the claim.** Sliding progress on a task no one is doing puts your name on it, wherever someone
   else could see it. On a project only you can see, there's no one to tell, so nothing is claimed.
7. **Nothing closes behind your back.** A parent whose subtasks are all done waits for **Close**, and ticked rows wait
   for the batch before they leave.
8. **Bulk actions confirm; single actions undo.** Completing a parent's open subtasks asks first; a tick, a delete or a
   move of one task has its Undo or Restore instead.
9. **What you share matches what you see.** A shared text or a copied list says the same figures the screen shows.
