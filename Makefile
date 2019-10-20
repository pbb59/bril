TESTS := \
    test/proj2/div-anal/*.bril \
    test/proj2/*.bril \
    test/proj1/*.bril \
    test/parse/*.bril \
	test/print/*.json \
	test/interp/*.bril \
	test/ts/*.ts

.PHONY: test
test:
	turnt $(TESTS)

.PHONY: save
save:
	turnt --save $(TESTS)
