// mkfixture writes the synthetic test archive to a directory (for e2e tests).
package main

import (
	"fmt"
	"os"

	"github.com/dkurth/slackdumpviewer/internal/fixture"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: mkfixture <dir>")
		os.Exit(2)
	}
	if err := os.RemoveAll(os.Args[1]); err != nil {
		panic(err)
	}
	if _, err := fixture.Build(os.Args[1]); err != nil {
		panic(err)
	}
}
