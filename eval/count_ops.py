# Evaluate how well the divergence optimization did by counting the number of ALU ops performed
# Any vector instruction in general requires 4 ops (ignore predication b/c still using vector reg)
# while scalar in general requires 1 op

# Usage: bril2json < x.bril | python3 count_ops.py

import sys, json

vOps = 4
sOps = 1

# just specify which ones consume vOps, all others take sOps
cost_table = {
  'vadd' : vOps,
  's2v'  : vOps,
  'vphi' : vOps,
  'vload': vOps,
  'vstore': vOps,
  'vcmp' : vOps,
  
  # assume can write a entire vec reg with a single scalar in one op
  's2vb' : sOps,
}


def count_ops():
    # accumulate cost
    cost = 0

    # get the program
    bril = json.load(sys.stdin)

    for func in bril['functions']:
        for instr in func['instrs']:
            if 'op' in instr:
                if instr['op'] in cost_table:
                    cost += cost_table[instr['op']]
                else:
                    cost += sOps

    print(cost)


if __name__ == '__main__':
    count_ops()
