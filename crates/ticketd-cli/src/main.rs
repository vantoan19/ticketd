use clap::Parser;

#[derive(Parser)]
#[command(name = "ticketd", version, about = "Local ticket workspace")]
struct Arguments {}

fn main() {
    let _arguments = Arguments::parse();
}
