//! Print the public JSON Schema for the ticket source extension contract.

use std::io::{self, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut output = io::stdout().lock();
    serde_json::to_writer_pretty(&mut output, &ticketd_core::source::contract_schema())?;
    writeln!(output)?;
    Ok(())
}
