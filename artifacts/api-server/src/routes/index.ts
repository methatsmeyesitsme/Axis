import { Router, type IRouter } from "express";
import healthRouter from "./health";
import openaiRouter from "./openai";
import authRouter from "./auth";
import cortexRouter from "./cortex";
import forgeRouter from "./forge";
import githubRouter from "./github";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/openai", openaiRouter);
router.use("/cortex", cortexRouter);
router.use("/forge", forgeRouter);
router.use("/github", githubRouter);

export default router;
