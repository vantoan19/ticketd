//! Whether a schedule has come due. No SQL and no clock: the caller hands in the
//! local time now and the local time the schedule last counted from.

use chrono::{Datelike, Days, NaiveDateTime, NaiveTime, TimeDelta};

use crate::automations::{Schedule, Weekday};

/// How a time of day is written in a schedule.
const TIME: &str = "%H:%M";

pub(crate) fn time_of_day(time: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(time.trim(), TIME).ok()
}

/// Whether the schedule had a time to run after `since`, up to and including `now`.
/// However many it had, the answer is one yes: a schedule missed while ticketd was
/// not running fires once. `since` is when the schedule last fired, or when it was
/// switched on or changed.
pub(crate) fn due(schedule: &Schedule, since: NaiveDateTime, now: NaiveDateTime) -> bool {
    match schedule {
        Schedule::EveryHours { hours } => {
            *hours > 0 && now - since >= TimeDelta::hours(i64::from(*hours))
        }
        Schedule::Weekly { time, weekdays } => {
            let Some(time) = time_of_day(time) else {
                return false;
            };
            // A week back reaches the latest time of every weekday.
            (0..=7).any(|back| {
                now.date()
                    .checked_sub_days(Days::new(back))
                    .is_some_and(|day| {
                        let at = day.and_time(time);
                        weekdays.contains(&weekday(day.weekday())) && since < at && at <= now
                    })
            })
        }
    }
}

fn weekday(day: chrono::Weekday) -> Weekday {
    match day {
        chrono::Weekday::Mon => Weekday::Mon,
        chrono::Weekday::Tue => Weekday::Tue,
        chrono::Weekday::Wed => Weekday::Wed,
        chrono::Weekday::Thu => Weekday::Thu,
        chrono::Weekday::Fri => Weekday::Fri,
        chrono::Weekday::Sat => Weekday::Sat,
        chrono::Weekday::Sun => Weekday::Sun,
    }
}
