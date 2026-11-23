mod api;
mod linear;
mod model;
mod publication;

use ticketd_source_sdk::serve_stdio;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let description = serde_json::from_str(include_str!("../description.json"))?;
    let tracker = linear::Linear::new(description)?;
    serve_stdio(env!("CARGO_PKG_VERSION"), tracker)?;
    Ok(())
}
