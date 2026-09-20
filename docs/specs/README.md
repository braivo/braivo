# Specifications

One file per area of behavior that is worth pinning down before or alongside the code that implements it: the rules, the inputs they act on, and the cases that prove them.

A spec differs from an ADR in what happens when it changes. An ADR records a decision as it was taken and is superseded rather than rewritten; a spec describes how something currently works and is kept current with the code. Write a spec when behavior is intricate enough that reading the implementation is a poor way to learn the rules. Record the choice between alternatives as an ADR and reference it.

- [Learning model v1](learning-model.md)
