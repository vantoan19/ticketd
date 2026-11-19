/**
 * The longest a new or changed title or Plan name may be. The core enforces both
 * (`MAX_TITLE` in ticket_change.rs, `MAX_NAME` in plans.rs); the fields carry them as
 * `maxLength` so typing stops at the limit instead of failing on save.
 */
export const TITLE_MAX_LENGTH = 1000;
export const PLAN_NAME_MAX_LENGTH = 1000;
