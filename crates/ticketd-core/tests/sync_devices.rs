//! The computers that share a Workspace, as Settings lists them: read from the device
//! registry as this computer last saw it, so the list needs neither a sign-in nor a network.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Setup that fails must fail the test.

use ticketd_core::sync::AttachmentDownload;

#[path = "support/sync_desks.rs"]
mod sync_desks;

use sync_desks::{Devices, desks};

#[test]
fn a_computer_that_never_synced_is_the_only_one_listed() {
    let desks = desks();
    let desk = desks.desk("MacBook Pro");

    let list = desk.sync_devices().unwrap();

    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "MacBook Pro");
    assert_eq!(list[0].code, desk.device_code().unwrap());
    assert!(list[0].this);
    assert_eq!(list[0].last_synced_at, None);
}

#[test]
fn this_computer_comes_first_and_the_others_carry_their_last_change() {
    let mut devices = Devices::new(&["MacBook Pro", "Mac mini"]);
    // The change that sets "last change" on the Mac mini.
    devices.workspaces[1]
        .create_ticket("From the mini")
        .unwrap();
    devices.sync(1);
    devices.sync(0);

    let list = devices.workspaces[0].sync_devices().unwrap();

    let names: Vec<_> = list.iter().map(|device| device.name.as_str()).collect();
    assert_eq!(names, ["MacBook Pro", "Mac mini"]);
    assert_eq!(
        list.iter().map(|device| device.this).collect::<Vec<_>>(),
        [true, false]
    );
    assert_eq!(list[1].code, devices.workspaces[1].device_code().unwrap());
    assert!(list[1].last_synced_at.is_some());
    // The same list from the other computer puts that one first.
    let other = devices.workspaces[1].sync_devices().unwrap();
    assert_eq!(other[0].name, "Mac mini");
    assert!(other[0].this && !other[1].this);
}

#[test]
fn a_rename_shows_here_at_once_and_reaches_the_other_computer_by_its_next_run() {
    let mut devices = Devices::new(&["MacBook Pro", "Mac mini"]);

    devices.workspaces[0]
        .set_sync_settings("Studio", 60, AttachmentDownload::Automatic)
        .unwrap();
    // Here: at once, before any run.
    assert_eq!(
        devices.workspaces[0].sync_devices().unwrap()[0].name,
        "Studio"
    );
    // The other computer still has the old name until it reads the registry again.
    assert_eq!(
        devices.workspaces[1].sync_devices().unwrap()[1].name,
        "MacBook Pro"
    );

    devices.workspaces[0].create_ticket("Renamed").unwrap();
    devices.sync(0);
    devices.sync(1);

    let list = devices.workspaces[1].sync_devices().unwrap();
    assert_eq!(list[1].name, "Studio");
}
