fn main() {
    std::process::exit(grove::cli::run(std::env::args().skip(1).collect()));
}
