# MoonBit Markdown Linter

This is a Markdown linter for MoonBit. It gathers all MoonBit codes in Markdown, checks them using MoonBit's compiler, and reports any diagnostics.

# Prerequisites

To use the MoonBit Markdown Linter, you need to install the [MoonBit compiler](https://www.moonbitlang.com/download/).

# Install

```
npm install -g @moonbit/markdown-linter
```

# Usage

## Check Syntax and Type Errors

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
$ mdlint fib.md
fib.md:6:4-6:7 Warning 001: Unused function 'fib'
fib.md:9:14-9:18 Expr Type Mismatch
        has type : Bool
        wanted   : Int
```

## Run Inline Test or Evaluate Expression

In file identity.md:

    # Identity

    ```mbt
    fn id[T : Eq](x : T) -> T {
    x
    }
    ```

    Print `id(5)` in `init` function.

    ```mbt init
    debug(id(5))
    ```

    You can also write expression directly.

    ```mbt expr
    id(5)
    ```

    Test function `id`.

    ```mbt
    test "id" {
    if id(5) != 5 { return Result::Err("test failed") }
    }
    ```

Run test and evaluate the expression by `mdlint`:

```
$ mdlint identity.md
5
5
running 1 tests in package identity
test identity::id ... ok

test result: 1 passed; 0 failed
```