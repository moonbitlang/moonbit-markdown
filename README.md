# MoonBit Markdown Linter

This is a Markdown linter for MoonBit. It gathers all MoonBit codes in Markdown, checks them using MoonBit's compiler, and reports any diagnostics.

# Prerequisites

To use the MoonBit Markdown Linter, you need to install the [MoonBit compiler](https://www.moonbitlang.com/download/).

# Usage

Create a markdown file `fib.md`, write some MoonBit code in code block:

    # Fibonacci

    Calculate the nth Fibonacci number using recursion and pattern matching.
    
    ```mbt
    fn fib(n : Int) -> Int {
        match n {
            0 => 0
            1 => true // type error here
            _ => fib(n - 1) + fib(n - 2)
        }
    }
    ```

Check it by MoonBit markdown linter.

```
node markdown-linter.js fib.md
```

```
fib.md:6:4-6:7 Warning 001: Unused function 'fib'
fib.md:9:14-9:18 Expr Type Mismatch
        has type : Bool
        wanted   : Int
```